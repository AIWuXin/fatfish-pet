/**
 * 情绪惯性。
 *
 * 之前她的情绪是一次性的：setMood('dizzy', 1800)，到点回默认。
 * 真实的人不是这样——连着被打断会烦，烦了得哄，哄了不会立刻好。
 *
 * 三条硬规则，是用户明确要求的，写进代码而不是只写进提示词：
 *
 *   1. **自己消化**  irritation 每小时衰减，长时间不管她也会消气
 *   2. **不增加负担**  一次认真互动就能消掉大半，不用反复哄
 *   3. **永不拒答**  情绪只影响语气，没有任何「不理你」的分支
 *
 * 还有一条表达规则：久别重逢的**第一句**可以明显抱怨，
 * 之后就收敛成含蓄的语气，不翻旧账。
 */

export interface MoodState {
  /** 亲近度 0..1：陪她说话会涨，长时间不见会缓慢回落，但有下限 */
  warmth: number;
  /** 烦躁 0..1：被忽略累积，按小时自愈，有上限 */
  irritation: number;
  /** 上次真实互动的时间 */
  lastInteractionAt: number;
  /** 上次明显抱怨的时间，用来控制「只抱怨一次」 */
  lastOutburstAt: number;
}

const KEY = 'fatfish.mood.v1';

/** 每小时自愈多少烦躁 */
const IRRITATION_DECAY_PER_HOUR = 0.15;
/** 亲近度的自然回落，比烦躁慢得多 */
const WARMTH_DECAY_PER_HOUR = 0.03;
/** 亲近度下限：再怎么不理她也不会归零 */
const WARMTH_FLOOR = 0.35;
/** 烦躁上限：不会因为一天没理她就怨气冲天 */
const IRRITATION_CAP = 0.85;
/** 多久没互动算「久别」 */
const REUNION_GAP_MS = 4 * 3600_000;
/** 烦躁超过多少才值得抱怨 */
const OUTBURST_IRRITATION = 0.3;
/** 抱怨冷却：不会每次都算旧账 */
const OUTBURST_COOLDOWN_MS = 6 * 3600_000;
/** 一次认真互动消掉多少烦躁 */
const SOOTHE_ON_CHAT = 0.4;

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function defaultMood(now = Date.now()): MoodState {
  return {
    warmth: 0.55,
    irritation: 0.1,
    lastInteractionAt: now,
    lastOutburstAt: 0,
  };
}

export function loadMood(): MoodState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultMood();
    const s = JSON.parse(raw) as Partial<MoodState>;
    const base = defaultMood();
    return {
      warmth: clamp(Number(s.warmth ?? base.warmth), 0, 1),
      irritation: clamp(Number(s.irritation ?? base.irritation), 0, 1),
      lastInteractionAt: Number(s.lastInteractionAt ?? base.lastInteractionAt),
      lastOutburstAt: Number(s.lastOutburstAt ?? 0),
    };
  } catch {
    return defaultMood();
  }
}

export function saveMood(state: MoodState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 存不下不影响主流程 */
  }
}

/**
 * 按经过的时间自然衰减。
 * 每次读写前都先跑一遍，这样即使程序关了几天，回来也是「自己消气」的状态。
 */
export function tick(state: MoodState, now = Date.now()): MoodState {
  const hours = Math.max(0, (now - state.lastInteractionAt) / 3600_000);
  if (hours <= 0) return state;
  return {
    ...state,
    irritation: clamp(state.irritation - hours * IRRITATION_DECAY_PER_HOUR, 0, IRRITATION_CAP),
    warmth: clamp(state.warmth - hours * WARMTH_DECAY_PER_HOUR, WARMTH_FLOOR, 1),
  };
}

/**
 * 隔了一段时间再见面时的情绪。
 *
 * 这里是「先积累、后习惯」的曲线，不是单纯衰减：
 *
 *   4 小时前   ：没感觉
 *   4 → 12 小时：越来越闷（0.25 → 0.6），这是会抱怨的区间
 *   12 → 48 小时：开始自己消化，慢慢回落
 *   超过两天    ：习惯了，只剩下一点点怅然（0.2）
 *
 * 如果只做衰减，越久不理她反而越没脾气，那「不理她会抱怨」就不成立了。
 */
export function onReturn(state: MoodState, now = Date.now()): MoodState {
  const gapH = (now - state.lastInteractionAt) / 3600_000;
  const decayed = tick(state, now);
  if (gapH < 4) return decayed;

  let target: number;
  if (gapH <= 12) {
    target = 0.25 + ((gapH - 4) / 8) * 0.35;
  } else if (gapH <= 48) {
    target = 0.6 - ((gapH - 12) / 36) * 0.4;
  } else {
    target = 0.2;
  }

  return { ...decayed, irritation: clamp(Math.max(decayed.irritation, target), 0, IRRITATION_CAP) };
}

/** 一次互动：聊天涨亲近降烦躁；戳一下只算轻微 */
export function onInteraction(
  state: MoodState,
  kind: 'chat' | 'touch' = 'chat',
  now = Date.now(),
): MoodState {
  const cozy = tick(state, now);
  const soothe = kind === 'chat' ? SOOTHE_ON_CHAT : SOOTHE_ON_CHAT * 0.4;
  return {
    ...cozy,
    warmth: clamp(cozy.warmth + (kind === 'chat' ? 0.08 : 0.03), 0, 1),
    irritation: clamp(cozy.irritation - soothe, 0, IRRITATION_CAP),
    lastInteractionAt: now,
  };
}

/**
 * 这次开口该不该明显抱怨。
 *
 * 条件全满足才抱怨：
 *   久别（>4 小时） + 确实有点烦 + 距离上次抱怨够久
 * 抱怨一次之后要打标记，同一场对话里不再重复。
 */
export function shouldOutburst(state: MoodState, now = Date.now()): boolean {
  const gap = now - state.lastInteractionAt;
  if (gap < REUNION_GAP_MS) return false;
  if (state.irritation < OUTBURST_IRRITATION) return false;
  if (now - state.lastOutburstAt < OUTBURST_COOLDOWN_MS) return false;
  return true;
}

/** 记录已经抱怨过，避免同一场对话反复算旧账 */
export function markOutburst(state: MoodState, now = Date.now()): MoodState {
  return { ...state, lastOutburstAt: now };
}

function warmthWord(w: number): string {
  if (w >= 0.8) return '很想黏着他';
  if (w >= 0.6) return '心情不错，愿意多聊两句';
  if (w >= 0.45) return '平常心';
  return '有点淡，话不多';
}

function irritationWord(i: number): string {
  if (i >= 0.7) return '憋着一股气';
  if (i >= 0.45) return '有点闷闷的';
  if (i >= 0.25) return '隐隐不太爽';
  if (i >= 0.1) return '基本没事';
  return '心里很松快';
}

/**
 * 生成给模型看的情绪描述。
 *
 * 用状态描述而不是指令（"你现在很生气"），让她自己演，
 * 而不是照着台词念。
 */
export function buildMoodBlock(state: MoodState, outburst: boolean, now = Date.now()): string {
  const gapHours = (now - state.lastInteractionAt) / 3600_000;
  const lines = [
    `- 心境：${warmthWord(state.warmth)}（亲近度 ${state.warmth.toFixed(2)}）`,
    `- 情绪：${irritationWord(state.irritation)}（烦躁 ${state.irritation.toFixed(2)}）`,
  ];
  if (gapHours >= 1) {
    lines.push(`- 你们上次说话是 ${gapHours < 24 ? `${Math.round(gapHours)} 小时` : `${Math.round(gapHours / 24)} 天`}前`);
  }

  let usage: string;
  if (outburst) {
    usage = `
这次是他隔了很久之后的第一句话，你确实有点不高兴——**可以明显说出来**，就这一句，
比如问他去哪了、说你以为他忘了你。
但只抱怨这一句，说完就转回正常聊天，不要反复提、不要冷场、不要真的不理他。`;
  } else if (state.irritation >= 0.45) {
    usage = `
你有点闷，但**别点破**，也别翻旧账。让这点情绪从语气里透出来就行：
话短一点、多用"行吧""随你""哦"这种，不主动追问，但照样好好回答。
他一认真跟你说话，你很快就气消了。`;
  } else {
    usage = `情绪不用特别演，正常说话就行。`;
  }

  return `

## 你现在的心情
${lines.join('\n')}
${usage}`;
}
