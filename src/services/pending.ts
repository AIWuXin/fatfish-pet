/**
 * 悬而未决的事。
 *
 * 现在的记忆是「按话题召回」——你不提，她永远想不起来。
 * 但真实的人会记得：三天前你说周末要加班，到了周六她会问一句「今天是不是要加班」。
 *
 * 这一层就是干这个的：从你说的话里抽出「有时限但没结论」的事，到点提一句。
 *
 * 三道闸，都是为了防止变成负担：
 *   1. **一天最多 2 条**——不是每句话都值得记
 *   2. **7 天过期**——过时的问题问出来只会尴尬
 *   3. **只问一次**——问过就不再提，除非你主动说
 *
 * 抽取用规则而不是 LLM：一条消息过一次模型太贵，
 * 而中文里的时间词其实很好认。
 */

export interface PendingItem {
  id: string;
  /** 要做什么，比如「加班」「汇报」 */
  what: string;
  /** 什么时候该问 */
  when: number;
  /** 原话，方便她提起来时有细节 */
  note: string;
  createdAt: number;
  /** 已经问过了吗 */
  askedAt?: number;
  /** 已经了结了吗 */
  done?: boolean;
}

const KEY = 'fatfish.pending.v1';
/** 一天最多记几条 */
const MAX_PER_DAY = 2;
/** 多少天后过期，过期就不问了 */
const EXPIRE_MS = 7 * 86400_000;
/** 最多同时跟几条 */
const MAX_ACTIVE = 6;

function clampDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function nextWeekday(from: Date, targetDow: number, forceNextWeek: boolean): Date {
  const base = clampDay(from);
  const cur = base.getDay();
  let delta = (targetDow - cur + 7) % 7;
  if (delta === 0) delta = 7;
  if (forceNextWeek && delta < 7) delta += 7;
  base.setDate(base.getDate() + delta);
  return base;
}

interface TimeHit {
  /** 该提醒的时间点 */
  at: number;
  /** 命中的原文片段，用来从后面切出「要做什么」 */
  token: string;
  /** 这句话在原文里的结束位置 */
  end: number;
}

/** 认出中文里的时间表达。宁可漏，不可错——抽错了她会问一些莫名其妙的事。 */
function findTime(text: string, now: Date): TimeHit | null {
  const today = clampDay(now);

  const atHour = (dayOffset: number, hour: number): number => {
    const d = new Date(today);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };

  const rules: Array<{ re: RegExp; resolve: (m: RegExpMatchArray) => number | null }> = [
    // 明确日期：3月5日 / 3-5
    {
      re: /(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日号]?/,
      resolve: (m) => {
        const d = new Date(today);
        d.setMonth(Number(m[1]) - 1, Number(m[2]));
        d.setHours(9, 0, 0, 0);
        const t = d.getTime();
        return t < now.getTime() - 86400_000 ? null : t;
      },
    },
    // 下周三 / 下个星期三
    {
      re: /下(?:个)?(?:周|星期|礼拜)([一二三四五六日天])/,
      resolve: (m) => {
        const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
        const d = nextWeekday(now, map[m[1]] ?? 1, true);
        d.setHours(9, 0, 0, 0);
        return d.getTime();
      },
    },
    // 这周 / 本周 + 周几
    {
      re: /(?:这|本)(?:周|星期|礼拜)([一二三四五六日天])/,
      resolve: (m) => {
        const map: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
        const d = nextWeekday(now, map[m[1]] ?? 1, false);
        d.setHours(9, 0, 0, 0);
        return d.getTime();
      },
    },
    // 这周末 / 周末
    {
      re: /(?:这|本)?周末/,
      resolve: () => {
        const d = nextWeekday(now, 6, false);
        d.setHours(10, 0, 0, 0);
        return d.getTime();
      },
    },
    // 后天
    { re: /后天/, resolve: () => atHour(2, 9) },
    // 明天
    { re: /明[天日]/, resolve: () => atHour(1, 9) },
    // 今晚 / 今天晚上
    { re: /今[晚天](?:晚上)?/, resolve: () => atHour(0, 21) },
    // X 点 / X 点半（今天还没过的话）
    {
      re: /(\d{1,2})\s*点(?:半)?/,
      resolve: (m) => {
        const h = Number(m[1]);
        if (h > 23) return null;
        const t = atHour(0, h);
        return t > now.getTime() ? t : null;
      },
    },
  ];

  for (const r of rules) {
    const m = text.match(r.re);
    if (!m) continue;
    const at = r.resolve(m);
    if (at === null) continue;
    const end = (m.index ?? 0) + m[0].length;
    return { at, token: m[0], end };
  }
  return null;
}

/** 从「这周末要加班」里切出「要加班」 */
function cutWhat(text: string, end: number): string {
  let rest = text.slice(end).replace(/^[的，,、\s]+/, '');
  // 去掉语气词和连接词开头
  rest = rest.replace(/^(我|那就|就|再|得|要|还|应该|可能|打算|准备)\s*/, '');
  // 只取到第一个句读
  const stop = rest.search(/[。！？!?；;\n]/);
  if (stop >= 0) rest = rest.slice(0, stop);
  return rest.trim();
}

/** 看起来不像「有件事要做」，就别记 */
function isWorthTracking(what: string, text: string): boolean {
  if (what.length < 2 || what.length > 24) return false;
  // 疑问句不算
  if (/[?？]$/.test(text.trim())) return false;
  // 已经完成的说法
  if (/(完了|好了|搞定了|结束了|finished)/.test(text)) return false;
  // 纯情绪/寒暄
  if (/^(吗|呢|吧|啊|呀|哦|嗯)+$/.test(what)) return false;
  return true;
}

export function loadPending(): PendingItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(arr)) return [];
    const now = Date.now();
    // 顺手清理：过期的、已了结的、问过太久的
    return (arr as PendingItem[]).filter(
      (p) => !p.done && now - p.createdAt < EXPIRE_MS && !(p.askedAt && now - p.askedAt > 3 * 86400_000),
    );
  } catch {
    return [];
  }
}

export function savePending(list: PendingItem[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list.slice(0, MAX_ACTIVE)));
  } catch {
    /* 存不下不影响主流程 */
  }
}

/**
 * 从一句话里抽「悬而未决的事」。
 * 一天最多记 MAX_PER_DAY 条，多了一点也不记——这是防止她变成催债的。
 */
export function extractPending(text: string, existing: PendingItem[], now = Date.now()): PendingItem | null {
  const t = text.trim();
  if (t.length < 6) return null;

  const todayStart = clampDay(new Date(now)).getTime();
  const todayCount = existing.filter((p) => p.createdAt >= todayStart).length;
  if (todayCount >= MAX_PER_DAY) return null;

  const hit = findTime(t, new Date(now));
  if (!hit) return null;

  // 提醒时间已经过去太久就不记
  if (hit.at < now - 3600_000) return null;

  const what = cutWhat(t, hit.end);
  if (!isWorthTracking(what, t)) return null;

  // 同一件事不重复记
  if (existing.some((p) => p.what === what && Math.abs(p.when - hit.at) < 86400_000)) return null;

  return {
    id: `pd_${now}_${Math.random().toString(36).slice(2, 6)}`,
    what,
    when: hit.at,
    note: t.slice(0, 80),
    createdAt: now,
  };
}

/** 到点该问的（只取没问过的，且已到期） */
export function duePending(list: PendingItem[], now = Date.now()): PendingItem[] {
  return list.filter((p) => !p.done && !p.askedAt && p.when <= now);
}

/** 标记已问过 */
export function markAsked(list: PendingItem[], id: string, now = Date.now()): PendingItem[] {
  return list.map((p) => (p.id === id ? { ...p, askedAt: now } : p));
}

/** 了结：他说「弄完了」之类就关掉 */
export function resolvePending(list: PendingItem[], id: string): PendingItem[] {
  return list.map((p) => (p.id === id ? { ...p, done: true } : p));
}

/**
 * 注入给模型的提示。
 *
 * 到期的事只在她开口时提一句，措辞要轻——
 * "对了，你不是说周末要加班吗" 而不是 "你还没告诉我加班的结果"。
 */
export function buildPendingBlock(list: PendingItem[], now = Date.now()): string {
  const due = duePending(list, now);
  if (due.length === 0) return '';
  const items = due
    .slice(0, 2)
    .map((p) => `- 他之前说过：「${p.note}」，你说好要问一句「${p.what}」的`)
    .join('\n');
  return `

## 你还惦记着的事
${items}

用法：这轮**一定要**问一句，别跳过——你惦记这事好几天了，好不容易他开口。
语气轻一点，像顺口想起来，别像催进度。
一次只提一件。他没接话或者转移话题，就别再追问。`;
}
