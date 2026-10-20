/**
 * 评论配额与风控闸门。
 *
 * 2026-10-19 她因为评论太频繁被 B 站禁言了。复盘出三个问题：
 *
 *   1. 日上限可配置成 6000，等于没有上限
 *   2. 只有「一天几条」，没有「多久一条」——可以一秒连发
 *   3. 发失败（比如已经被风控）时只算「处理过了」，既不记录也不停手，
 *      于是一整夜反复撞墙，越撞越重
 *
 * 这个文件补上这三道闸。B 站那边的错误码：
 *   -352     触发风控验证
 *   12015    需要验证/被封禁
 *   12051    评论过于频繁
 *   -412     请求被拦截
 *   12061    评论内容有问题
 */

const LOG_KEY = 'fatfish.bili.replylog.v1';
const GUARD_KEY = 'fatfish.bili.guard.v1';

/** 一天最多几条，代码强制封顶。界面上即使填再大也不让它超过这个数。 */
export const MAX_DAILY_CEILING = 30;
/** 默认日上限 */
export const DEFAULT_DAILY_CAP = 20;
/** 两次评论之间至少隔多久（毫秒）。B 站官方没有明确数字，按经验 3 分钟比较安全。 */
export const MIN_GAP_MS = 3 * 60_000;
/** 命中风控后停多久 */
export const BLOCK_HOURS = 3;

/** 会让整段时间停手的错误码 */
const HARD_BLOCK_CODES = new Set([-352, 12015, 12051, -412, 12061]);

interface ReplyLog {
  date: string;
  count: number;
}

export interface ReplyGuard {
  /** 上次成功发评论的时间 */
  lastAt: number;
  /** 停手到什么时候（0 表示没被挡） */
  blockedUntil: number;
  /** 上次失败的原因，方便面板上看到 */
  lastError: string;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadReplyCount(): number {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    if (!raw) return 0;
    const log = JSON.parse(raw) as ReplyLog;
    return log.date === today() ? log.count : 0;
  } catch {
    return 0;
  }
}

export function incReplyCount(): number {
  const next = loadReplyCount() + 1;
  localStorage.setItem(LOG_KEY, JSON.stringify({ date: today(), count: next }));
  return next;
}

export function loadGuard(): ReplyGuard {
  try {
    const raw = localStorage.getItem(GUARD_KEY);
    if (!raw) return { lastAt: 0, blockedUntil: 0, lastError: '' };
    const g = JSON.parse(raw) as Partial<ReplyGuard>;
    return {
      lastAt: Number(g.lastAt ?? 0),
      blockedUntil: Number(g.blockedUntil ?? 0),
      lastError: String(g.lastError ?? ''),
    };
  } catch {
    return { lastAt: 0, blockedUntil: 0, lastError: '' };
  }
}

function saveGuard(g: ReplyGuard): void {
  try {
    localStorage.setItem(GUARD_KEY, JSON.stringify(g));
  } catch {
    /* 存不下不影响主流程 */
  }
}

/** 把用户填的上限夹到安全范围 */
export function clampDailyCap(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAILY_CAP;
  return Math.min(Math.floor(value), MAX_DAILY_CEILING);
}

/**
 * 现在能不能发评论。
 *
 * 三道检查：被风控挡着 / 今天额度用完 / 距上一条太近。
 */
export function canReply(dailyCap: number, now = Date.now()): { ok: boolean; reason?: string } {
  const g = loadGuard();
  if (now < g.blockedUntil) {
    const mins = Math.ceil((g.blockedUntil - now) / 60_000);
    return { ok: false, reason: `被 B 站风控挡着，还要等 ${mins} 分钟` };
  }
  if (loadReplyCount() >= clampDailyCap(dailyCap)) {
    return { ok: false, reason: '今天的额度用完了' };
  }
  if (g.lastAt > 0 && now - g.lastAt < MIN_GAP_MS) {
    const left = Math.ceil((MIN_GAP_MS - (now - g.lastAt)) / 60_000);
    return { ok: false, reason: `刚发过，还要等 ${left} 分钟` };
  }
  return { ok: true };
}

export function markReplySent(now = Date.now()): void {
  const g = loadGuard();
  saveGuard({ ...g, lastAt: now, lastError: '' });
}

/**
 * 记录一次发送失败。
 * 命中风控码就整段时间停手——继续撞只会让禁言更久。
 * @returns 是否触发了停手
 */
export function markReplyFailed(code: number, message: string, now = Date.now()): boolean {
  const g = loadGuard();
  const hard = HARD_BLOCK_CODES.has(code);
  saveGuard({
    ...g,
    lastAt: hard ? now : g.lastAt,
    blockedUntil: hard ? now + BLOCK_HOURS * 3600_000 : g.blockedUntil,
    lastError: `code=${code} ${message}`.slice(0, 160),
  });
  return hard;
}

/** 面板展示用：现在是什么状态 */
export function guardStatus(now = Date.now()): { blocked: boolean; until: number; lastError: string } {
  const g = loadGuard();
  return {
    blocked: now < g.blockedUntil,
    until: g.blockedUntil,
    lastError: g.lastError,
  };
}

/** 用户手动解除（确认账号已经恢复正常后） */
export function clearGuard(): void {
  saveGuard({ lastAt: 0, blockedUntil: 0, lastError: '' });
}
