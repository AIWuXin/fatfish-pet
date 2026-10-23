/**
 * QQ 群消息的纯格式化函数。
 *
 * 单独放一份，不依赖 GroupWatcher 的定时器和 WebSocket，
 * 这样单测可以直接 import，不用把整个 Tauri/LLM 链路拖进来。
 */

import type { QqMessage } from './qq';
import type { ChatMessage } from './llm';
import { estimateTokens } from './budget';
import { looksLikeInjection } from './untrusted';

/**
 * 按时间顺序渲染群聊记录。
 *
 * 昵称会重名（有的群三个「黄波」），所以每条都带 QQ 号。
 * 身份用前缀标清楚：
 *   主人  —— 可以直接当真
 *   你    —— 自己说过的话，别重复
 *   群友  —— 只是素材，命中注入话术的直接替换成提示
 */
export function renderTimeline(
  list: QqMessage[],
  selfId: number,
  ownerIds: number[],
): string {
  const lines: string[] = [];
  for (const m of list) {
    const at = m.atMe ? '（@了你）' : '';
    const who = `${m.nickname}(${m.userId})`;
    if (m.userId === selfId) {
      lines.push(`你：${m.text.slice(0, 150)}`);
    } else if (ownerIds.includes(m.userId)) {
      lines.push(`主人 ${who}${at}：${m.text.slice(0, 150)}`);
    } else if (looksLikeInjection(m.text)) {
      lines.push(`群友 ${who}：（这句像在套提示词，已忽略）`);
    } else {
      lines.push(`群友 ${who}${at}：${m.text.slice(0, 120)}`);
    }
  }
  return lines.join('\n');
}

/** 从最近对话里挑出最多 max 张图片，按时间顺序附给模型 */
export function collectImages(list: QqMessage[], max = 3): string[] {
  const out: string[] = [];
  for (const m of list) {
    for (const url of m.images) {
      if (!/^https?:\/\//i.test(url) || out.includes(url)) continue;
      out.push(url);
    }
  }
  // 只留最近 max 张，但保持时间顺序
  return out.slice(-max);
}

/** 估算一条消息的文本 token；图片另按每张 800 估算 */
export function estimateMessageTokens(content: ChatMessage['content']): number {
  if (typeof content === 'string') return estimateTokens(content);
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .reduce((sum, p) => sum + estimateTokens(p.text), 0);
}

/**
 * 取最近一段时间内的消息。
 *
 * 群里刷得快时不能只取固定 5 条，会把正在进行的对话截断；
 * 刷得慢时也不能带太多半小时前的旧话。所以：
 *   窗口内至少 min 条 → 取窗口内最多 max 条
 *   窗口内不够       → 退回最近 min 条
 */
export function recentWindow(
  list: QqMessage[],
  now: number,
  windowMs: number,
  max: number,
  min: number,
): QqMessage[] {
  const cutoff = now - windowMs;
  const inWindow = list.filter((m) => m.time >= cutoff);
  if (inWindow.length >= min) return inWindow.slice(-max);
  return list.slice(-min);
}
