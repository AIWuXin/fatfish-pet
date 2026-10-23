import { useCallback, useRef, useState } from 'react';
import { messageText, streamChat, type ChatMessage } from '../services/llm';
import { parseReply, stripPartialMarkers } from '../services/persona';
import type { MemoryItem } from '../services/memory';
import type { DiaryEntry } from '../services/diary';
import { asksForMemory, buildRecallBlock, recall, type ChatEvent } from '../services/recall';
import type { Impression } from '../services/impressions';
import type { PetSettings } from '../services/settings';
import {
  recordUsage,
  remainingTokens,
  estimateTokens,
  STARVED_SUFFIX,
  type BudgetState,
} from '../services/budget';
import {
  loadMood,
  markOutburst,
  onInteraction,
  onReturn,
  saveMood,
  shouldOutburst,
} from '../services/mood-state';
import { buildSystemPrompt } from '../services/prompt';
import {
  buildPendingBlock,
  duePending,
  extractPending,
  loadPending,
  markAsked,
  savePending,
} from '../services/pending';

/** 送给模型的最大轮数（超出部分走压缩） */
const MAX_TURNS = 14;
/** 上下文超过这个 token 数就压缩。384K，基本只有超长对话才会碰到 */
const COMPACT_TOKEN_THRESHOLD = 384 * 1024;
/** 压缩后保留多少 token 的原文。留四成，够接着聊 */
const KEEP_TOKEN_TARGET = 150 * 1024;
/** 兜底：条数太多也压（防止极短的碎消息堆成山） */
const COMPACT_MAX_MESSAGES = 240;
const KEEP_RECENT_MIN = 16;

function historyTokens(list: ChatMessage[]): number {
  return list.reduce((sum, m) => sum + estimateTokens(messageText(m.content)) + 4, 0);
}
const HISTORY_KEY = 'fatfish.chat.history.v1';

function loadHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ChatMessage[]).filter((m) => m.role !== 'system') : [];
  } catch {
    return [];
  }
}

/** localStorage 大概 5MB，按 token 留个安全上限，别把配额撑爆 */
const PERSIST_TOKEN_CAP = 300 * 1024;

function saveHistory(list: ChatMessage[]): void {
  try {
    let total = 0;
    let start = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
      const cost = estimateTokens(messageText(list[i].content)) + 4;
      if (total + cost > PERSIST_TOKEN_CAP) break;
      total += cost;
      start = i;
    }
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(start)));
  } catch {
    /* 存不下就算了 */
  }
}

/** 留给输出的余量：没这个数就别开口了 */
const MIN_OUTPUT_TOKENS = 300;

interface UsePetChatOptions {
  config: PetSettings;
  memories: MemoryItem[];
  diary: DiaryEntry[];
  chatEvents: ChatEvent[];
  onChatEvent: (text: string) => void;
  impressions: Impression[];
  budget: BudgetState;
  onBudgetChange: (next: BudgetState) => void;
  onMood: (mood: string) => void;
  onRemember: (content: string) => void;
  /** 压缩出来的对话摘要，交给外部存进事件记忆 */
  onCompact: (summary: string) => void;
  /** 预算不够时回调，由外部决定怎么撒娇 */
  onHungry: () => void;
}

export interface ChatResult {
  text: string;
  ok: boolean;
  /** 预算耗尽被中途掐断 */
  starved?: boolean;
}

function promptTokensOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(messageText(m.content)) + 4, 0);
}

export function usePetChat({
  config,
  memories,
  diary,
  chatEvents,
  onChatEvent,
  impressions,
  budget,
  onBudgetChange,
  onMood,
  onRemember,
  onCompact,
  onHungry,
}: UsePetChatOptions) {
  // 从本地恢复，重启之后还能接上上次的话题
  const historyRef = useRef<ChatMessage[]>(loadHistory());
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveText, setLiveText] = useState('');

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setLiveText('');
  }, []);

  /**
   * 统一的请求执行器：管预算、管截断、管记账。
   * 预算不够时立刻停，并在结尾挂一句「我还想吃大白饭」。
   */
  const run = useCallback(
    async (payload: ChatMessage[]): Promise<{ raw: string; starved: boolean; ok: boolean }> => {
      const remaining = remainingTokens(budget);
      const inputCost = promptTokensOf(payload);

      if (remaining < inputCost + MIN_OUTPUT_TOKENS) {
        return { raw: '', starved: true, ok: false };
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setLiveText('');

      let acc = '';
      let starved = false;
      let failed = false;
      let realUsage = 0;

      for await (const ev of streamChat(payload, config, controller.signal)) {
        if (ev.type === 'delta' && ev.content) {
          acc += ev.content;
          setLiveText(stripPartialMarkers(acc));

          // 流式过程中按估算值滚动检查，超了就立刻掐掉
          const spent = inputCost + estimateTokens(acc);
          if (spent > remaining) {
            starved = true;
            controller.abort();
            break;
          }
        } else if (ev.type === 'usage') {
          realUsage = (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
        } else if (ev.type === 'error') {
          failed = true;
          break;
        } else if (ev.type === 'done') {
          break;
        }
      }

      setBusy(false);
      setLiveText('');

      // 优先用服务端回的真实 usage，没有就按估算记
      const spent = realUsage > 0 ? realUsage : inputCost + estimateTokens(acc);
      if (spent > 0) onBudgetChange(recordUsage(budget, spent));

      if (failed && !starved) return { raw: '', starved: false, ok: false };
      return { raw: acc, starved, ok: true };
    },
    [budget, config, onBudgetChange],
  );

  /**
   * 上下文压缩：把最早的一段对话压成一句"我们聊过什么"，存进事件记忆。
   * 不做这个的话，超出窗口的部分是被直接扔掉的——那不叫记忆。
   */
  const compact = useCallback(async (): Promise<void> => {
    const hist = historyRef.current;
    const total = historyTokens(hist);
    if (total <= COMPACT_TOKEN_THRESHOLD && hist.length <= COMPACT_MAX_MESSAGES) return;

    // 按 token 从最新往回装，装到留够 KEEP_TOKEN_TARGET 为止
    let keep = 0;
    let cut = hist.length;
    while (cut > 0 && hist.length - cut < COMPACT_MAX_MESSAGES) {
      const cost = estimateTokens(messageText(hist[cut - 1].content)) + 4;
      if (keep + cost > KEEP_TOKEN_TARGET && hist.length - cut >= KEEP_RECENT_MIN) break;
      keep += cost;
      cut -= 1;
    }
    const old = hist.slice(0, cut);

    // 先裁历史再摘要：摘要失败也不能让窗口一直爆着
    historyRef.current = hist.slice(cut);
    saveHistory(historyRef.current);

    const transcript = old
      .map((m) => `${m.role === 'user' ? '他' : '你'}：${m.content.slice(0, 200)}`)
      .join('" + BS + "n');

    try {
      const payload: ChatMessage[] = [
        {
          role: 'system',
          content: `（系统旁白）把下面这段对话压成一两句，只保留有价值的东西：
- 关于他的新信息（在做什么、在意什么、情绪状态、约定）
- 你们之间发生的关键事（分歧、玩笑、承诺）
不要复述原话，不要写成"用户说"这种格式，不要评价。输出一句话，不超过 60 字。`,
        },
        { role: 'user', content: transcript.slice(0, 3000) },
      ];

      let acc = '';
      for await (const ev of streamChat(payload, config)) {
        if (ev.type === 'delta' && ev.content) acc += ev.content;
        else if (ev.type === 'error' || ev.type === 'done') break;
      }

      const summary = acc.trim().slice(0, 120);
      (window as unknown as Record<string, unknown>).__compactDebug = {
        accLen: acc.length,
        head: acc.slice(0, 120),
        summary,
        at: Date.now(),
      };
      if (summary) onCompact(summary);
    } catch (err) {
      (window as unknown as Record<string, unknown>).__compactDebug = {
        error: err instanceof Error ? err.message : String(err),
        at: Date.now(),
      };
    }
  }, [config, onCompact]);

  const send = useCallback(
    async (input: string): Promise<ChatResult> => {
      const text = input.trim();
      if (!text) return { text: '', ok: false };

      if (!config.apiKey || !config.endpoint || !config.model) {
        return { text: '我还没连上脑子，先去设置里填一下 API。', ok: false };
      }

      // 召回：facts 和最近 8 条日记已经全量注入，这里只补更早的和聊天事件
      const hits = recall(text, {
        facts: [],
        diary: diary.slice(8),
        chatEvents,
        deep: asksForMemory(text),
      });

      // 心情、时间、惦记的事：每轮现算，不缓存
      const now = Date.now();
      const moodState = onReturn(loadMood(), now);
      const outburst = shouldOutburst(moodState, now);
      const pendingList = loadPending();

      const system: ChatMessage = {
        role: 'system',
        content: buildSystemPrompt({
          scene: 'chat',
          identity: { real: 'wuxin', biliName: config.biliAtName || undefined },
          memories,
          diary,
          impressions,
          recallBlock: buildRecallBlock(hits),
          pendingBlock: buildPendingBlock(pendingList, now),
          outburst,
        }),
      };

      const dueNow = duePending(pendingList, now);
      const history = historyRef.current.slice(-MAX_TURNS * 2);
      const payload: ChatMessage[] = [system, ...history, { role: 'user', content: text }];

      const result = await run(payload);

      if (result.starved) {
        onHungry();
        return { text: '（碗空了……我还想吃大白饭）', ok: false, starved: true };
      }
      if (!result.ok) {
        historyRef.current = [...historyRef.current, { role: 'user', content: text }];
        return { text: '脑子卡住了，等下再说。', ok: false };
      }

      onChatEvent(text);

      // 这句里有「有时限但没结论」的事就记下来，到点再问
      const pend = loadPending();
      const fresh = extractPending(text, pend, Date.now());
      if (fresh) savePending([fresh, ...pend]);

      const { text: clean, mood, remember } = parseReply(result.raw);

      // 真的提到了才算问过。之前是注入就标记，模型没问也记成问过了，
      // 那次机会就白白浪费，还会一直不提。
      if (dueNow.length > 0) {
        const said = clean || result.raw || '';
        let list = loadPending();
        for (const p of dueNow) {
          const key = p.what.slice(0, 2);
          if (key && said.includes(key)) list = markAsked(list, p.id, Date.now());
        }
        savePending(list);
      }
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
        { role: 'assistant', content: clean || result.raw },
      ];

      if (mood) onMood(mood);
      if (remember) onRemember(remember);

      // 说上话了，烦消一点、亲近涨一点；刚才要是抱怨过就记一笔，同一场对话不再算旧账
      const after = Date.now();
      const before = onReturn(loadMood(), after);
      let next = onInteraction(before, 'chat', after);
      if (shouldOutburst(before, after)) next = markOutburst(next, after);
      saveMood(next);

      saveHistory(historyRef.current);
      void compact();

      const reply = clean || result.raw || '（想了半天，什么也没说）';
      return {
        text: result.starved ? reply + STARVED_SUFFIX : reply,
        ok: true,
        starved: result.starved,
      };
    },
    [config, memories, diary, chatEvents, onChatEvent, impressions, onCompact, run, onMood, onRemember, onHungry, compact],
  );

  /**
   * 主动搭话：prompt 是系统旁白，不进对话历史。
   * 她随口说一句，不记得上次自说自话的内容——这样反而更像"随口一提"。
   */
  const speakProactively = useCallback(
    async (hint: string): Promise<string | null> => {
      if (!config.apiKey || !config.endpoint || !config.model) return null;

      const payload: ChatMessage[] = [
        {
          role: 'system',
          content: buildSystemPrompt({
            scene: 'proactive',
            identity: { real: 'wuxin', biliName: config.biliAtName || undefined },
            memories,
            diary,
          }),
        },
        { role: 'user', content: hint },
      ];

      const result = await run(payload);
      if (result.starved) {
        onHungry();
        return null;
      }
      if (!result.ok || !result.raw) return null;

      const { text, mood, remember } = parseReply(result.raw);
      if (mood) onMood(mood);
      if (remember) onRemember(remember);

      // 说上话了，烦消一点、亲近涨一点；刚才要是抱怨过就记一笔，同一场对话不再算旧账
      const after = Date.now();
      const before = onReturn(loadMood(), after);
      let next = onInteraction(before, 'chat', after);
      if (shouldOutburst(before, after)) next = markOutburst(next, after);
      saveMood(next);
      return !result.starved ? text || null : (text || '') + STARVED_SUFFIX;
    },
    [config, memories, diary, chatEvents, onChatEvent, impressions, onCompact, run, onMood, onRemember, onHungry, compact],
  );

  const clear = useCallback(() => {
    historyRef.current = [];
    saveHistory([]);
  }, []);

  /**
   * 主动提一件到期的事。
   *
   * 不能只等用户先开口——他要是不说话，到期的提醒永远问不出来。
   * 所以这里由一个定时器驱动：隔了一阵没人搭理，就自己开口问一句。
   *
   * 两个克制：
   *   刚聊完不提（30 分钟内算「正在聊」）
   *   一次只提一件
   */
  const speakPending = useCallback(async (): Promise<string | null> => {
    const now = Date.now();
    const moodNow = loadMood();
    if (now - moodNow.lastInteractionAt < 30 * 60_000) return null;

    const list = loadPending();
    const due = duePending(list, now);
    if (due.length === 0) return null;

    const p = due[0];
    const hint = `（系统旁白，不是他说的）
你心里一直惦记着他之前讲过的话：「${p.note}」。
现在他安静了一阵，你主动问一句「${p.what}」怎么样了。
像忽然想起来那样自然，一两句话就够，别像查岗。`;

    const text = await speakProactively(hint);
    if (text) {
      const key = p.what.slice(0, 2);
      if (key && text.includes(key)) savePending(markAsked(loadPending(), p.id, Date.now()));
    }
    return text;
  }, [speakProactively]);

  return { send, stop, clear, speakProactively, speakPending, busy, liveText };
}
