/**
 * 评论配额：由剩余大白饭推导，不是拍脑袋定的固定数。
 *
 * 逻辑：
 *   还能逛几次 = 剩余 token / 单次逛站的平均消耗
 *   每次逛站最多换一条评论，所以「还能逛几次」就是「还能发几条」
 *
 * 另外保留一个硬上限，只防风控（B 站连发会弹验证码，返回 -352），
 * 跟预算无关——就算大白饭管够，也不该在一小时内刷十几条。
 */

import { remainingTokens, type BudgetState } from './budget';

/** 首次还没有历史数据时的保守估算（实测一轮约 1000–2500 token） */
const DEFAULT_BROWSE_COST = 2500;
/** 硬上限：跟预算无关，纯粹防 B 站风控 */
export const HARD_DAILY_CAP = 20;

export interface CommentQuota {
  /** 按剩余预算算，还能发几条 */
  byBudget: number;
  /** 按风控硬上限算，还能发几条 */
  byRisk: number;
  /** 实际可用 = 两者取小 */
  left: number;
  /** 单次逛站的平均消耗，用于展示 */
  avgCost: number;
}

/**
 * @param budget 当前预算状态
 * @param repliesToday 今天已经发了几条评论
 * @param browsedToday 今天已经逛了几次（用来算平均消耗）
 */
export function commentQuota(
  budget: BudgetState,
  repliesToday: number,
  browsedToday: number,
  hardCap = HARD_DAILY_CAP,
): CommentQuota {
  const remaining = remainingTokens(budget);

  // 用今天实际消耗除以逛的次数得到平均；没有数据就用默认值
  const spent = budget.date === todayKey() ? budget.usedToday : 0;
  const avgCost = browsedToday > 0 ? Math.max(300, Math.round(spent / browsedToday)) : DEFAULT_BROWSE_COST;

  const byBudget = Math.floor(remaining / avgCost);
  const byRisk = Math.max(0, hardCap - repliesToday);

  return { byBudget, byRisk, left: Math.min(byBudget, byRisk), avgCost };
}

/** 统计今天逛了几次，用来算单次平均消耗。 */
export function browsedTodayCount(entries: Array<{ at: number }>): number {
  const key = todayKey();
  return entries.filter((e) => {
    const d = new Date(e.at);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` === key;
  }).length;
}

function todayKey(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
