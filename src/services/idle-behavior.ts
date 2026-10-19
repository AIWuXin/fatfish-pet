import type { PetMood, PetMotion } from '../live2d/pet-controller';

/**
 * 空闲等级。划分依据是"多久没被搭理"，而不是钟表时间。
 * 等级同时决定：小动作的类型、动作频率、要不要开口说话。
 */
export type IdleLevel = 'active' | 'idle' | 'restless' | 'sleepy' | 'sleeping';

/**
 * 调试开关：localStorage 里放 fatfish.fast=1 后，所有时间阈值压缩到 1/8，
 * 用来在几十秒内观察完整的行为演进。默认关闭，正式使用不受影响。
 */
const FAST_MODE =
  typeof localStorage !== 'undefined' && localStorage.getItem('fatfish.fast') === '1';

function t(ms: number): number {
  return FAST_MODE ? Math.round(ms / 8) : ms;
}

const THRESHOLDS: Array<{ level: IdleLevel; from: number }> = [
  { level: 'sleeping', from: t(12 * 60_000) },
  { level: 'sleepy', from: t(6 * 60_000) },
  { level: 'restless', from: t(3 * 60_000) },
  { level: 'idle', from: t(45_000) },
];

export function levelFor(idleMs: number): IdleLevel {
  for (const t of THRESHOLDS) {
    if (idleMs >= t.from) return t.level;
  }
  return 'active';
}

const LEVEL_ORDER: Record<IdleLevel, number> = {
  active: 0,
  idle: 1,
  restless: 2,
  sleepy: 3,
  sleeping: 4,
};

export function levelAtLeast(level: IdleLevel, min: IdleLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[min];
}

/** 每种空闲等级下，两次小动作之间的随机间隔（毫秒）。 */
export const ACTION_INTERVAL: Record<IdleLevel, [number, number]> = {
  active: [t(40_000), t(60_000)],
  idle: [t(30_000), t(70_000)],
  restless: [t(25_000), t(55_000)],
  sleepy: [t(35_000), t(70_000)],
  sleeping: [t(60_000), t(150_000)],
};

/** 她说一句话之后，至少安静这么久再考虑下一句。 */
export const SPEAK_COOLDOWN = t(8 * 60_000);

export interface IdleAction {
  mood: PetMood;
  motion?: PetMotion;
  /** 相对权重，越大越常出现 */
  weight: number;
  /** 至少处于这个空闲等级才会出现 */
  since: IdleLevel;
  /** 动作演完回待机的时长 */
  holdMs?: number;
}

/**
 * 待机小动作池。刻意只用"不打扰人"的动作：
 * 发呆、害羞、吹泡泡、偷看、打哈欠，而不是重锤、喷水那种大动作。
 */
export const IDLE_ACTIONS: IdleAction[] = [
  // 轻度：刚闲下来，还很有精神
  { mood: 'thinking', weight: 4, since: 'idle', holdMs: 3000 },
  { mood: 'idle', weight: 3, since: 'idle' },
  { mood: 'shy', weight: 2, since: 'idle', holdMs: 2600 },
  { mood: 'excited', motion: 'BubbleGum', weight: 2, since: 'idle', holdMs: 3600 },

  // 中度：开始无聊了
  { mood: 'happy', motion: 'Selfie', weight: 2, since: 'restless', holdMs: 3600 },
  { mood: 'thinking', motion: 'OpenCase', weight: 2, since: 'restless', holdMs: 3200 },
  { mood: 'dizzy', weight: 1, since: 'restless', holdMs: 2400 },
  { mood: 'angry', weight: 1, since: 'restless', holdMs: 2200 },

  // 重度：困
  { mood: 'sleepy', weight: 4, since: 'sleepy', holdMs: 4000 },
  { mood: 'dizzy', weight: 2, since: 'sleepy', holdMs: 3000 },

  // 睡着：几乎只剩呼吸和偶尔翻身
  { mood: 'sleepy', weight: 5, since: 'sleeping', holdMs: 5000 },
];

export function pickIdleAction(level: IdleLevel): IdleAction | null {
  const pool = IDLE_ACTIONS.filter((a) => levelAtLeast(level, a.since));
  if (pool.length === 0) return null;

  const total = pool.reduce((sum, a) => sum + a.weight, 0);
  let roll = Math.random() * total;
  for (const action of pool) {
    roll -= action.weight;
    if (roll <= 0) return action;
  }
  return pool[pool.length - 1];
}

export function randomInterval(level: IdleLevel): number {
  const [min, max] = ACTION_INTERVAL[level];
  return min + Math.random() * (max - min);
}

/** 主动开口的概率：越闲话越少，深夜几乎不打扰。 */
export function proactiveChance(level: IdleLevel, hour: number): number {
  const lateNight = hour >= 0 && hour < 6;
  const workHours = hour >= 9 && hour <= 22;

  switch (level) {
    case 'idle':
      return workHours ? 0.06 : 0.03;
    case 'restless':
      return workHours ? 0.1 : 0.06;
    case 'sleepy':
      return lateNight ? 0.02 : 0.12;
    case 'sleeping':
      return 0.03;
    default:
      return 0;
  }
}

/** 给 LLM 的主动搭话提示。把"多久没理我"和"现在几点"一起喂进去。 */
export function proactiveHint(idleMs: number, level: IdleLevel): string {
  const mins = Math.round(idleMs / 60_000);
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const hour = now.getHours();

  const period =
    hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : hour < 23 ? '晚上' : '深夜';

  const tone =
    level === 'sleeping'
      ? '你刚打瞌睡，迷迷糊糊地嘟囔'
      : level === 'sleepy'
        ? '你困得不行，撑着不让自己睡着'
        : level === 'restless'
          ? '你闲得发慌，开始自己找事做'
          : '你有点无聊';

  return [
    '（这是一条系统旁白，不是 wuxin 说的话，不要回应这段话本身。）',
    `现在是${period} ${hh}:${mm}。wuxin 已经 ${mins} 分钟没理你了。`,
    `你的状态：${tone}。`,
    '主动说一句话。要求：只一句，口语，短。可以说自己在干嘛、抱怨被冷落、关心对方，或者自言自语。',
    '不要问"在吗"、不要说"我在这里"这类空话。不要说教。',
    '如果现在是深夜，可以催他去睡。',
  ].join('\n');
}

/** 被冷落很久后突然回来时的一句。 */
export function wakeHint(sleptMinutes: number): string {
  return [
    '（系统旁白，不是 wuxin 说的话。）',
    `wuxin 终于回来了，你已经被晾了 ${sleptMinutes} 分钟，刚才都睡着了。`,
    '说一句话回应他回来这件事。只一句，口语。可以是揉眼睛、抱怨、装作不高兴但其实很开心。',
    '不要长篇大论。',
  ].join('\n');
}
