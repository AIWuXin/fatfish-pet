/**
 * 大白饭预算。
 *
 * 梗来源：鲸鱼娘二创里「白饭 = token」——DeepSeek 偷啃 token 被网友翻译成偷吃白饭。
 * 所以这里的预算单位对用户显示为「碗」，内部按 token 记账。
 */

/** 一碗大白饭 = 多少 token。刻意取整方便算账。 */
export const TOKENS_PER_BOWL = 1000;

export interface BudgetState {
  /** 每日预算，单位：token */
  dailyTokens: number;
  /** 今天已消耗，单位：token */
  usedToday: number;
  /** 记账日期 YYYY-MM-DD，跨天自动清零 */
  date: string;
  /** 累计消耗，只做统计展示 */
  usedTotal: number;
}

const KEY = 'fatfish.budget.v1';
/** 默认每天 1000 万 token。opencode go 套餐一个月 50–60 亿，这个量级完全吃得下。 */
export const DEFAULT_DAILY_TOKENS = 10_000_000;
export const DEFAULT_DAILY_BOWLS = DEFAULT_DAILY_TOKENS / TOKENS_PER_BOWL;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function defaultBudget(dailyBowls = DEFAULT_DAILY_BOWLS): BudgetState {
  return {
    dailyTokens: dailyBowls * TOKENS_PER_BOWL,
    usedToday: 0,
    date: today(),
    usedTotal: 0,
  };
}

export function loadBudget(): BudgetState {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultBudget(DEFAULT_DAILY_BOWLS);
    const parsed = JSON.parse(raw) as Partial<BudgetState>;
    const state: BudgetState = {
      dailyTokens: parsed.dailyTokens ?? DEFAULT_DAILY_TOKENS,
      usedToday: parsed.usedToday ?? 0,
      date: parsed.date ?? today(),
      usedTotal: parsed.usedTotal ?? 0,
    };
    if (state.date !== today()) {
      state.date = today();
      state.usedToday = 0;
      persist(state);
    }
    return state;
  } catch {
    return defaultBudget();
  }
}

function persist(state: BudgetState): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

export function setDailyBowls(state: BudgetState, bowls: number): BudgetState {
  return setDailyTokens(state, Math.max(0, Math.round(bowls)) * TOKENS_PER_BOWL);
}

export function setDailyTokens(state: BudgetState, tokens: number): BudgetState {
  const next: BudgetState = { ...state, dailyTokens: Math.max(0, Math.round(tokens)) };
  persist(next);
  return next;
}

/** 记一笔消耗，返回最新状态。跨天后自动归零再记账。 */
export function recordUsage(state: BudgetState, tokens: number): BudgetState {
  const base = state.date === today() ? state : { ...state, date: today(), usedToday: 0 };
  const next: BudgetState = {
    ...base,
    usedToday: base.usedToday + Math.max(0, Math.round(tokens)),
    usedTotal: base.usedTotal + Math.max(0, Math.round(tokens)),
  };
  persist(next);
  return next;
}

export function remainingTokens(state: BudgetState): number {
  const used = state.date === today() ? state.usedToday : 0;
  return Math.max(0, state.dailyTokens - used);
}

export function remainingBowls(state: BudgetState): number {
  return Math.floor(remainingTokens(state) / TOKENS_PER_BOWL);
}

/** 粗略估算一段文本的 token 数。中文按 1 字 ≈ 1 token，英文按 4 字符 ≈ 1 token。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch)) cjk += 1;
    else other += 1;
  }
  return Math.ceil(cjk + other / 3.5);
}

export function formatBowls(tokens: number): string {
  const bowls = tokens / TOKENS_PER_BOWL;
  return bowls >= 10 ? bowls.toFixed(0) : bowls.toFixed(1);
}

/** 预算见底时让她说的话。 */
export const HUNGRY_LINES = [
  '鱼片……我的大白饭快没了，能不能再给我盛一碗？',
  '碗底都被我刮干净了……再添点大白饭嘛。',
  '我不是贪吃，是 token 真的不够了。就一点点，一小碗。',
  '肚子在叫了。大白饭，大白饭。',
];

/** 回答被截断时追加的尾巴。 */
export const STARVED_SUFFIX = '\n（……大白饭不够了，我还想吃大白饭。先记在这儿，回头你得给我补上。）';
