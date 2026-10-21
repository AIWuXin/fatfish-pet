import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { PetStage } from './components/PetStage';
import { Composer } from './components/Composer';
import { SettingsPanel } from './components/SettingsPanel';
import { BiliLogin } from './components/BiliLogin';
import { MemoryPanel } from './components/MemoryPanel';
import { loadBlocked } from './services/untrusted';
import { PetController, type PetMood, type PetMotion } from './live2d/pet-controller';
import { usePetChat } from './hooks/usePetChat';
import { useAutonomy } from './hooks/useAutonomy';
import { loadSettings, saveSettings, type PetSettings } from './services/settings';
import { addMemory, loadMemories, removeMemory, type MemoryItem } from './services/memory';
import { loadBudget, remainingTokens, setDailyTokens, HUNGRY_LINES, type BudgetState } from './services/budget';
import { browseBilibili, peekFeed } from './services/browsing';
import { addDiary, loadDiary, type DiaryEntry } from './services/diary';
import { incReplyCount, loadReplyCount } from './services/reply-limit';
import { browsedTodayCount, commentQuota } from './services/quota';
import { handleReplies } from './services/social';
import { dmLeft, handleDms, loadQuota } from './services/dm';
import { QqClient } from './services/qq';
import { GroupWatcher } from './services/qq-group';
import { addChatEvent, loadChatEvents, type ChatEvent } from './services/recall';
import { loadImpressions, reflect, removeImpression, type Impression } from './services/impressions';

const MODEL_URL = '/live2d/models/ds-whale-girl/c_0120.model3.json';

const IDLE_LINES = [
  '嗯？怎么了。',
  '我在呢。',
  '摸鱼中，勿扰。',
  '今天的代码写完了吗？',
  '别一直盯着我看啦。',
];

const POKE_REACTIONS: Array<{ line: string; mood: PetMood; motion?: PetMotion }> = [
  { line: '干嘛戳我！', mood: 'angry', motion: 'Hammer' },
  { line: '嘿嘿，痒。', mood: 'shy' },
  { line: '看我吐泡泡～', mood: 'happy', motion: 'BubbleGum' },
  { line: '喷你一脸水！', mood: 'excited', motion: 'SprayWater' },
  { line: '来拍一张？', mood: 'happy', motion: 'Selfie' },
  { line: '有点晕……别晃。', mood: 'dizzy' },
];

const MOOD_MAP: Record<string, PetMood> = {
  happy: 'happy',
  excited: 'excited',
  sad: 'sad',
  angry: 'angry',
  shy: 'shy',
  dizzy: 'dizzy',
  thinking: 'thinking',
  sleepy: 'sleepy',
  idle: 'idle',
};

interface CursorInfo {
  x: number;
  y: number;
  inside: boolean;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export default function App() {
  const controllerRef = useRef<PetController | null>(null);
  if (!controllerRef.current) controllerRef.current = new PetController();
  const controller = controllerRef.current;

  const [ready, setReady] = useState(false);
  const [bubble, setBubble] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [settings, setSettings] = useState<PetSettings>(() => loadSettings());
  const [memories, setMemories] = useState<MemoryItem[]>(() => loadMemories());
  const [budget, setBudget] = useState<BudgetState>(() => loadBudget());
  const [diary, setDiary] = useState<DiaryEntry[]>(() => loadDiary());
  const [chatEvents, setChatEvents] = useState<ChatEvent[]>(() => loadChatEvents());
  const [impressions, setImpressions] = useState<Impression[]>(() => loadImpressions());

  const [biliLoggedIn, setBiliLoggedIn] = useState(false);
  const [selfMid, setSelfMid] = useState(0);
  const [biliLoginOpen, setBiliLoginOpen] = useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false);

  // 设置里的预算和记账本同步：改过设置就立刻生效，不用等下次保存
  useEffect(() => {
    const want = settings.dailyWanTokens * 10_000;
    if (want > 0 && budget.dailyTokens !== want) {
      setBudget((b) => setDailyTokens(b, want));
    }
  }, [settings.dailyWanTokens, budget.dailyTokens]);

  useEffect(() => {
    void invoke<{ loggedIn: boolean; uid: string }>('bili_auth_status')
      .then((r) => {
        setBiliLoggedIn(Boolean(r.loggedIn));
        setSelfMid(Number(r.uid) || 0);
      })
      .catch(() => {});
  }, [biliLoginOpen]);

  const bubbleTimer = useRef<number | null>(null);

  const say = useCallback((text: string, duration = 4200) => {
    setBubble(text);
    if (bubbleTimer.current) window.clearTimeout(bubbleTimer.current);
    bubbleTimer.current = window.setTimeout(() => setBubble(null), duration);
  }, []);

  const onMood = useCallback(
    (mood: string) => {
      const mapped = MOOD_MAP[mood] ?? 'idle';
      controller.setMood(mapped, 3000);
    },
    [controller],
  );

  const onRemember = useCallback((content: string) => {
    setMemories(addMemory(content));
  }, []);

  /** 大白饭见底：撒娇要预算，别硬撑 */
  const handleHungry = useCallback(() => {
    controller.setMood('sad', 3200);
    say(pick(HUNGRY_LINES), 9000);
  }, [controller, say]);

  const chat = usePetChat({
    config: settings,
    memories,
    diary,
    chatEvents,
    onChatEvent: (text) => setChatEvents(addChatEvent(text)),
    impressions,
    onCompact: (summary) => {
      // 摘要标记成 summary：可以召回，但不能当他的原话去推断印象
      setChatEvents(addChatEvent(summary, 'summary'));
    },
    budget,
    onBudgetChange: setBudget,
    onMood,
    onRemember,
    onHungry: handleHungry,
  });

  /** 只跑回复环节：看看谁回了她，值得回的回一句。 */
  const runSocialCheck = useCallback(
    async (silent = false): Promise<number> => {
      if (!biliLoggedIn || selfMid === 0) return 0;
      try {
        const social = await handleReplies(selfMid, {
          config: settings,
          budget,
          onBudgetChange: setBudget,
          onStatus: (text) => {
            if (!silent) say(text, 3000);
          },
        });

        if (social.replied > 0) {
          controller.setMood('happy', 3000);
          say(social.lines.join('\n'), 10000);
        }
        return social.replied;
      } catch {
        return 0;
      }
    },
    [biliLoggedIn, selfMid, settings, budget, controller, say],
  );

  /**
   * 处理未读私信。
   *
   * 私信比公开评论安全，但也不能一口气回一百个——
   * 一轮最多三个，每人每天 50 条，发失败立刻停手。
   */
  const runDmCheck = useCallback(
    async (silent = false): Promise<number> => {
      if (!biliLoggedIn || selfMid === 0) return 0;
      try {
        const r = await handleDms({
          config: settings,
          budget,
          selfUid: selfMid,
          nickname: settings.biliAtName || '主人',
          onBudgetChange: setBudget,
          onStatus: (text) => {
            if (!silent) say(text, 3000);
          },
        });
        if (r.replied > 0) {
          controller.setMood('happy', 3000);
          say(r.lines.slice(0, 2).join('\n'), 9000);
        }
        if (r.blocked) {
          console.warn('[dm] 发送被拒:', r.blocked);
        }
        return r.replied;
      } catch {
        return 0;
      }
    },
    [biliLoggedIn, selfMid, settings, budget, controller, say],
  );

  // ---------------- QQ 群 ----------------
  // 用 ref 兜住随时会变的设置与预算，避免它们进 effect 依赖导致连接抖动
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const budgetRef = useRef(budget);
  budgetRef.current = budget;
  const qqRef = useRef<QqClient | null>(null);
  const groupRef = useRef<GroupWatcher | null>(null);
  const [qqStatus, setQqStatus] = useState<'off' | 'connecting' | 'on'>('off');

  /**
   * 连上 NapCat 并把群消息接进来。
   *
   * 开关关掉、或者没填 QQ 号时整个不启动——
   * 不连就不会有任何后台流量，也不会误发消息。
   */
  useEffect(() => {
    if (!settings.qq || !settings.qqSelfId) {
      groupRef.current?.stop();
      qqRef.current?.close();
      qqRef.current = null;
      groupRef.current = null;
      setQqStatus('off');
      return;
    }
    if (qqRef.current) return;

    setQqStatus('connecting');
    const client = new QqClient({
      wsUrl: settings.qqWsUrl || 'ws://127.0.0.1:3001',
      selfId: settings.qqSelfId,
      allowedGroups: settings.qqGroups ?? [],
    });

    const watcher = new GroupWatcher({
      client,
      getSettings: () => settingsRef.current,
      getBudget: () => budgetRef.current,
      selfId: settings.qqSelfId,
      nickname: settings.biliAtName || '主人',
      allowedGroups: settings.qqGroups ?? [],
      ownerIds: settings.qqOwnerIds ?? [],
      onBudgetChange: setBudget,
      onSpeak: (_gid, text) => {
        controller.setMood('happy', 2500);
        say(text, 7000);
      },
      onLog: (line) => console.info('[qq]', line),
    });

    const off = client.onMessage((msg) => watcher.ingest(msg));
    client.onStatus((ok, info) => {
      setQqStatus(ok ? 'on' : 'connecting');
      if (!ok && info) console.warn('[qq]', info);
    });

    client.connect();
    watcher.start();
    qqRef.current = client;
    groupRef.current = watcher;

    return () => {
      off();
      watcher.stop();
      client.close();
      qqRef.current = null;
      groupRef.current = null;
      setQqStatus('off');
    };
    // 依赖里不放 settings/budget —— 每次记账都会变，会导致连接反复重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.qq, settings.qqSelfId, settings.qqWsUrl, JSON.stringify(settings.qqGroups)]);

  /** 自己去 B 站逛一圈。用 ref 中转，避免 hook 之间循环依赖。 */
  const browsingRef = useRef(false);
  const browseHandlerRef = useRef<() => void>(() => {});
  const handleBrowse = useCallback(async () => {
    if (browsingRef.current) return;
    if (!settings.bilibili || !settings.apiKey) return;

    if (remainingTokens(budget) < 1500) {
      controller.setMood('sad', 3200);
      say(pick(HUNGRY_LINES), 9000);
      return;
    }

    browsingRef.current = true;

    // 先看看有没有人回了她
    const replied = await runSocialCheck();
    if (replied > 0) {
      await new Promise((r) => setTimeout(r, 3500));
    }

    controller.setMood('excited', 2600);
    say('我去 B 站翻翻。', 2400);

    try {
      const result = await browseBilibili({
        config: settings,
        diary,
        budget,
        onBudgetChange: setBudget,
        onStatus: (text) => say(text, 2600),
      });

      if (result === 'hungry') {
        handleHungry();
        return;
      }
      if (!result) {
        controller.setMood('dizzy', 2400);
        say('B 站打不开，算了。', 3200);
        return;
      }

      controller.setMood(MOOD_MAP[result.mood ?? 'idle'] ?? 'happy', 3200);
      const rawTitle = result.video.title;
      const title = rawTitle.length > 16 ? `${rawTitle.slice(0, 16)}…` : rawTitle;

      // 登录了才真发，没登录只说想说什么
      let published = false;
      let atHit = false;
      let verifyNote = '';
      let myRpid = 0;

      // 配额由剩余大白饭推导：还能逛几次，就能发几条
      const quota = commentQuota(
        budget,
        loadReplyCount(),
        browsedTodayCount(diary),
        settings.maxCommentsPerDay,
      );
      const quotaBlocked =
        result.comment && biliLoggedIn && quota.left <= 0
          ? quota.byBudget <= 0
            ? '（大白饭不够了，这轮没发评论）'
            : '（今天评论到上限了，先攒着）'
          : '';

      if (quotaBlocked) {
        verifyNote = quotaBlocked;
      } else if (result.comment && biliLoggedIn) {
        // B 站靠解析正文里的「@昵称 」来生成 @，没有单独的参数
        const atName = settings.biliAtName.trim();
        // 正文里不能残留 @，否则 B 站会把它后面那串也当成用户名去匹配
        const cleanComment = result.comment.replace(/@/g, ' ').replace(/\s+/g, ' ').trim();
        const message = atName ? `@${atName} ${cleanComment}` : cleanComment;
        try {
          const res = await invoke<{ ok: boolean; members?: string[] }>('bili_reply', {
            aid: result.video.aid,
            message,
          });
          published = res.ok;
          atHit = Boolean(res.members && res.members.length > 0);

          if (res.ok) {
            incReplyCount();
            myRpid = (res as { rpid?: number }).rpid ?? 0;
            // 接口回"发送成功"不等于公开可见：新号或风控会进审核，别人看不到也收不到通知
            const rpid = (res as { rpid?: number }).rpid ?? 0;
            if (rpid > 0) {
              await new Promise((r) => setTimeout(r, 3000));
              try {
                const chk = await invoke<{ visible: boolean | null; note: string }>('bili_check_reply', {
                  aid: result.video.aid,
                  rpid,
                });
                if (chk.visible !== true) verifyNote = '（暂未在最新一页查到，可能还在审核）';
              } catch {
                /* 复核失败不算发布失败 */
              }
            }
          }
        } catch {
          published = false;
        }
      }

      const atName = settings.biliAtName.trim();
      const atNote = atHit ? `，@了${atName}` : '';
      const tail = result.comment
        ? published
          ? `
（评论区留了句：${result.comment}${atNote}）${verifyNote}`
          : `
（想留一句：${result.comment}）${verifyNote}`
        : '';
      say(`看了《${title}》。${result.thought}${tail}`, 14000);

      // 记进她自己的日记，下次聊天能想起来
      setDiary(
        addDiary({
          title: result.video.title,
          bvid: result.video.bvid,
          thought: result.thought,
          comment: published ? result.comment : '',
          aid: result.video.aid,
          rpid: myRpid > 0 ? myRpid : undefined,
          repliedTo: [],
        }),
      );
      (window as unknown as Record<string, unknown>).__petLastBrowse = {
        title: result.video.title,
        tname: result.video.tname,
        thought: result.thought,
        comment: result.comment,
        published,
        atHit,
        verifyNote,
      };
    } finally {
      browsingRef.current = false;
    }
  }, [settings, budget, controller, say, handleHungry, runSocialCheck]);

  // 自主行为：没人理她时自己找事做，闲久了主动开口
  const autonomy = useAutonomy({
    controller,
    actionsEnabled: settings.idleActions,
    proactiveEnabled: settings.proactive,
    busy: chat.busy,
    panelOpen: chatOpen || settingsOpen,
    onIdleAction: (action) => {
      controller.setMood(action.mood, action.holdMs ?? 2600);
      if (action.motion) {
        controller.playMotion(action.motion);
        window.setTimeout(() => controller.playMotion('Idle'), 3800);
      }
    },
    onProactive: (hint) => {
      void chat.speakProactively(hint).then((text) => {
        if (text) say(text, 9000);
      });
    },
    browseEnabled: settings.bilibili,
    onBrowse: () => browseHandlerRef.current(),
    onWake: (hint) => {
      controller.setMood('dizzy', 1800);
      void chat.speakProactively(hint).then((text) => {
        if (text) say(text, 8000);
      });
    },
  });

  // 说话时驱动口型
  useEffect(() => {
    controller.setTalking(chat.busy);
  }, [chat.busy, controller]);

  // 评论区轮询：启动 30 秒后先翻一次，之后每 10 分钟再看
  //
  // 之前只有一个 setTimeout —— 开机查一次就再也不查了，
  // 别人回了她只能等下次启动才知道。现在补上周期检查。
  useEffect(() => {
    if (!biliLoggedIn || selfMid === 0) return;
    const first = window.setTimeout(() => {
      void runSocialCheck(true);
      void runDmCheck(true);
    }, 30000);
    const ticker = window.setInterval(() => {
      void runSocialCheck(false);
      void runDmCheck(true);
    }, 10 * 60_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(ticker);
    };
  }, [biliLoggedIn, selfMid, runSocialCheck, runDmCheck]);

  // 到期的事主动开口：每 20 分钟看一次，真正该不该提由 speakPending 自己判断
  useEffect(() => {
    const ticker = window.setInterval(() => {
      void chat.speakPending().then((t) => {
        if (t) say(t, 9000);
      });
    }, 20 * 60_000);
    return () => window.clearInterval(ticker);
  }, [chat, say]);

  browseHandlerRef.current = () => {
    void handleBrowse();
  };

  const publishHitRegion = useCallback(() => {
    const r = controller.getHitRect();
    if (r.w <= 0 || r.h <= 0) return;
    void invoke('set_hit_region', { x: r.x, y: r.y, w: r.w, h: r.h }).catch(() => {});
  }, [controller]);

  const handleReady = useCallback(() => {
    setReady(true);
    publishHitRegion();
    controller.setMood('happy', 1800);
    say('我上线啦。', 2600);
  }, [controller, publishHitRegion, say]);

  /**
   * 全局光标轮询：一处轮询同时干两件事
   * 1. 窗口外的鼠标也能牵动视线
   * 2. 光标离开角色轮廓时把窗口切成点击穿透，不挡下层应用
   */
  const clickThroughRef = useRef(false);
  useEffect(() => {
    const timer = window.setInterval(async () => {
      try {
        const info = await invoke<CursorInfo>('cursor_info');
        controller.focusAt(info.x, info.y);
        if (info.inside) autonomy.touch();

        // 交互面板打开时保持窗口可点，否则鼠标一离开角色就没法操作面板
        const keepAlive = chatOpen || settingsOpen || biliLoginOpen || memoryOpen;

        const r = controller.getHitRect();
        const pad = 6;
        const inPet =
          r.w > 0 &&
          info.x >= r.x - pad &&
          info.x <= r.x + r.w + pad &&
          info.y >= r.y - pad &&
          info.y <= r.y + r.h + pad;

        // 底部工具条也得算可交互区，否则鼠标滑到底部窗口就穿透了，按钮永远点不到
        const dockTop = window.innerHeight - 62;
        const inDock =
          info.x >= 16 && info.x <= window.innerWidth - 16 && info.y >= dockTop && info.y <= window.innerHeight;

        const inside = keepAlive || inPet || inDock;

        const wantIgnore = !inside;
        if (wantIgnore !== clickThroughRef.current) {
          clickThroughRef.current = wantIgnore;
          await invoke('set_click_through', { ignore: wantIgnore });
        }
      } catch {
        // Tauri 命令不可用时（浏览器预览）静默降级
      }
    }, 50);
    return () => window.clearInterval(timer);
  }, [controller, chatOpen, settingsOpen, biliLoginOpen, memoryOpen, autonomy]);

  useEffect(() => {
    const onResize = () => window.setTimeout(publishHitRegion, 120);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [publishHitRegion]);

  // 托盘菜单「设置…」把窗口叫回来后，通知前端打开面板
  useEffect(() => {
    const pending = listen('pet://open-settings', () => {
      setChatOpen(false);
      setSettingsOpen(true);
    });
    return () => {
      void pending.then((un) => un());
    };
  }, []);

  const handlePoke = useCallback(() => {
    if (!ready || chatOpen) return;
    autonomy.touch();
    const r = pick(POKE_REACTIONS);
    if (r.motion) {
      controller.playMotion(r.motion);
      window.setTimeout(() => controller.playMotion('Idle'), 3600);
    }
    controller.setMood(r.mood, 2400);
    say(r.line);
  }, [ready, chatOpen, controller, say, autonomy]);

  const handleIdleTalk = useCallback(() => {
    if (!ready) return;
    controller.setMood('thinking', 2000);
    say(pick(IDLE_LINES));
  }, [ready, controller, say]);

  const handleSend = useCallback(
    async (text: string) => {
      if (!settings.apiKey) {
        setSettingsOpen(true);
        say('先把 API Key 填上，我才能说话。', 3400);
        return;
      }
      autonomy.touch();
      setChatOpen(true);
      controller.setMood('thinking', 1200);
      const result = await chat.send(text);
      say(result.text, 9000);
      if (!result.ok) controller.setMood('dizzy', 2200);
    },
    [settings.apiKey, chat, controller, say, autonomy],
  );

  const handleSaveSettings = useCallback((s: PetSettings) => {
    setSettings(s);
    saveSettings(s);
    setBudget((b) => setDailyTokens(b, s.dailyWanTokens * 10_000));
  }, []);

  const handleRemoveMemory = useCallback((id: string) => {
    setMemories(removeMemory(id));
  }, []);

  /**
   * 单击 = 戳她；按住拖动 = 移动窗口。
   * 不用 data-tauri-drag-region，因为它抢在 pointerdown 就开拖，单击永远触发不了。
   */
  const dragRef = useRef({ sx: 0, sy: 0, dragging: false });
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragRef.current = { sx: e.screenX, sy: e.screenY, dragging: false };
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = dragRef.current;
      if (e.buttons !== 1) return;

      if (!d.dragging) {
        if (Math.hypot(e.screenX - d.sx, e.screenY - d.sy) > 5) {
          d.dragging = true;
          void getCurrentWindow().startDragging().catch(() => {});
        }
        return;
      }

      const dx = e.screenX - d.sx;
      const dy = e.screenY - d.sy;
      d.sx = e.screenX;
      d.sy = e.screenY;
      controller.nudge(dx, dy);
    },
    [controller],
  );

  const onPointerUp = useCallback(() => {
    const d = dragRef.current;
    if (!d.dragging) handlePoke();
    dragRef.current.dragging = false;
    controller.release();
  }, [controller, handlePoke]);

  /** 跑一次反思：从最近的材料里更新她对你的印象。每天最多一次。 */
  const reflectRef = useRef({ diary, chatEvents, settings, budget });
  reflectRef.current = { diary, chatEvents, settings, budget };

  const runReflect = useCallback(
    async (force = false): Promise<{ added: string[]; reinforced: number } | null> => {
      const cur = reflectRef.current;
      if (!cur.settings.apiKey) return null;
      const last = Number(localStorage.getItem('fatfish.impressions.at') || 0);
      // 同一个 6 小时内不重复反思，避免反复烧钱
      if (!force && Date.now() - last < 6 * 3600_000) return null;

      const r = await reflect({
        config: cur.settings,
        budget: cur.budget,
        onBudgetChange: setBudget,
        chatEvents: cur.chatEvents,
        diary: cur.diary,
      });
      localStorage.setItem('fatfish.impressions.at', String(Date.now()));
      if (r.list.length > 0) setImpressions(r.list);
      return { added: r.added, reinforced: r.reinforced };
    },
    [],
  );

  // 反思：启动 3 分钟后看一次，之后每 3 小时看一次（真的跑与否由 6 小时节流决定）
  useEffect(() => {
    if (!settings.apiKey) return;
    const first = window.setTimeout(() => void runReflect(false), 3 * 60_000);
    const ticker = window.setInterval(() => void runReflect(false), 3 * 3600_000);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(ticker);
    };
  }, [settings.apiKey, runReflect]);

  // 调试出口：CDP 里可以直接触发回复环节
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__petSocial = () => runSocialCheck(false);
    (window as unknown as Record<string, unknown>).__petBlocked = () => loadBlocked();
    (window as unknown as Record<string, unknown>).__petPending = () => chat.speakPending();
    (window as unknown as Record<string, unknown>).__petFeed = () => peekFeed();
    (window as unknown as Record<string, unknown>).__petDm = () => runDmCheck(false);
    (window as unknown as Record<string, unknown>).__petDmQuota = () => ({ quota: loadQuota(), left: dmLeft(325031572) });
    (window as unknown as Record<string, unknown>).__petQq = () => ({
      status: qqStatus,
      groups: groupRef.current ? 'watching' : 'idle',
      detail: groupRef.current?.status ?? null,
    });
    (window as unknown as Record<string, unknown>).__petQqGroups = async () => {
      const r = await qqRef.current?.getGroups();
      return r ?? 'not connected';
    };
    (window as unknown as Record<string, unknown>).__petReflect = () => runReflect(true);
  }, [runSocialCheck, runReflect]);

  // 调试出口：CDP 里可以直接读 window.__petState 看自主行为状态
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__petState = {
      level: autonomy.level,
      idleMinutes: autonomy.idleMinutes,
      busy: chat.busy,
      bubble: bubble,
    };
  }, [autonomy.level, autonomy.idleMinutes, chat.busy, bubble]);

  const bubbleText = useMemo(() => {
    if (chat.busy && chat.liveText) return chat.liveText;
    return bubble;
  }, [chat.busy, chat.liveText, bubble]);

  return (
    <div className="pet-root" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}>
      <PetStage controller={controller} modelUrl={MODEL_URL} onReady={handleReady} />

      {!ready && <div className="pet-loading">正在捞鱼…</div>}

      {bubbleText && (
        <div className="bubble-wrap">
          <div className="bubble">{bubbleText}</div>
        </div>
      )}

      <Composer
        open={chatOpen}
        busy={chat.busy}
        onSend={handleSend}
        onStop={chat.stop}
        onClose={() => setChatOpen(false)}
      />

      {settingsOpen && (
        <SettingsPanel
          settings={settings}
          memories={memories}
          diary={diary}
          impressions={impressions}
          onSave={handleSaveSettings}
          onRemoveMemory={handleRemoveMemory}
          onClose={() => setSettingsOpen(false)}
          biliLoggedIn={biliLoggedIn}
          remainingTokens={remainingTokens(budget)}
          totalTokens={budget.dailyTokens}
          quotaLeft={commentQuota(budget, loadReplyCount(), browsedTodayCount(diary), settings.maxCommentsPerDay).left}
          avgBrowseCost={
            commentQuota(budget, loadReplyCount(), browsedTodayCount(diary), settings.maxCommentsPerDay).avgCost
          }
          onOpenBiliLogin={() => {
            setSettingsOpen(false);
            setBiliLoginOpen(true);
          }}
          onOpenMemory={() => {
            setSettingsOpen(false);
            setMemoryOpen(true);
          }}
          onBiliLogout={() => {
            void invoke('bili_logout').then(() => setBiliLoggedIn(false)).catch(() => {});
          }}
        />
      )}

      {memoryOpen && (
        <MemoryPanel
          impressions={impressions}
          memories={memories}
          diary={diary}
          chatEvents={chatEvents}
          onDeleteImpression={(id) => setImpressions(removeImpression(id))}
          onDeleteMemory={(id) => setMemories(removeMemory(id))}
          onClose={() => {
            setMemoryOpen(false);
            setSettingsOpen(true);
          }}
        />
      )}

      {biliLoginOpen && (
        <BiliLogin
          onClose={() => {
            setBiliLoginOpen(false);
            setSettingsOpen(true);
          }}
          onLoggedIn={() => {
            setBiliLoggedIn(true);
            setBiliLoginOpen(false);
          }}
        />
      )}

      <div className="dock" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
        <button className="dock-btn" title="跟她说话" onClick={() => setChatOpen(true)}>
          ✎
        </button>
        <button className="dock-btn" title="戳一下" onClick={handlePoke}>
          ✦
        </button>
        <button className="dock-btn" title="随口一句" onClick={handleIdleTalk}>
          ♪
        </button>
        <button className="dock-btn" title="让她去逛 B 站" onClick={() => void handleBrowse()}>
          ▷
        </button>
        <button className="dock-btn" title="设置" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
        <button
          className="dock-btn"
          title="收进托盘"
          onClick={() => {
            void invoke('hide_window').catch(() => {});
          }}
        >
          —
        </button>
      </div>
    </div>
  );
}
