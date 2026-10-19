/**
 * 召回层：从她记得的东西里，挑出"此刻该想起来的"。
 *
 * 和 Loom 的 recall 工具不同——那个是模型主动下钻查档案，为了保任务连续。
 * 这里的召回是自动的：每轮对话前按当前话题检索，只塞几条最相关的。
 * 她要的效果是"自然想起来"，不是"翻档案"。
 *
 * 打分 = 关键词命中 × 时间衰减 × 情绪权重
 */

import type { MemoryItem } from './memory';
import type { DiaryEntry } from './diary';

export type MemorySource = 'fact' | 'event' | 'chat';

export interface MemoryHit {
  source: MemorySource;
  /** 送给模型看的一句话 */
  text: string;
  /** 发生时间，用于渲染「三天前」这类说法 */
  at?: number;
  score: number;
}

/** 聊天里他说过的话（M1 的一部分） */
export interface ChatEvent {
  at: number;
  text: string;
}

const CHAT_EVENTS_KEY = 'fatfish.chat.events.v1';
const MAX_CHAT_EVENTS = 400;

export function loadChatEvents(): ChatEvent[] {
  try {
    const raw = localStorage.getItem(CHAT_EVENTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as ChatEvent[]) : [];
  } catch {
    return [];
  }
}

/** 记一句他说过的话。太短的（"嗯""好"）不记，没有信息量。 */
export function addChatEvent(text: string): ChatEvent[] {
  const t = text.trim();
  if (t.length < 6) return loadChatEvents();
  const next = [{ at: Date.now(), text: t.slice(0, 300) }, ...loadChatEvents()].slice(0, MAX_CHAT_EVENTS);
  try {
    localStorage.setItem(CHAT_EVENTS_KEY, JSON.stringify(next));
  } catch {
    /* 存不下就算了 */
  }
  return next;
}

/** 中文按二元组切，英文按词切。够用了，不值得引入分词库。 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const out = new Set<string>();

  for (const seg of lower.match(/[\u4e00-\u9fa5]+/g) ?? []) {
    if (seg.length === 1) out.add(seg);
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  for (const w of lower.match(/[a-z0-9]{2,}/g) ?? []) out.add(w);
  return Array.from(out);
}

/** 越近的事权重越高，但不会归零——三年前的约定也还值得想起来。 */
function timeWeight(at: number | undefined): number {
  if (!at) return 1;
  const days = (Date.now() - at) / 86400000;
  return 1 / (1 + days / 45);
}

function overlapScore(queryTokens: Set<string>, text: string): number {
  if (queryTokens.size === 0) return 0;
  const tokens = tokenize(text);
  if (tokens.length === 0) return 0;
  let hit = 0;
  for (const t of tokens) {
    if (queryTokens.has(t)) hit += 1;
  }
  // 用 query 长度归一，长文本不会因为词多就占便宜
  return hit / Math.sqrt(queryTokens.size * Math.max(6, tokens.length * 0.35));
}

export interface RecallOptions {
  facts: MemoryItem[];
  diary: DiaryEntry[];
  chatEvents: ChatEvent[];
  /** 返回条数上限 */
  limit?: number;
  /** 放宽阈值：用户问「还记得吗」时用 */
  deep?: boolean;
}

/** 按当前这句话，从三层记忆里挑相关的 */
export function recall(query: string, opts: RecallOptions): MemoryHit[] {
  const q = new Set(tokenize(query));
  const limit = opts.limit ?? 4;
  // 阈值：普通对话只取强相关，深挖时放宽
  const threshold = opts.deep ? 0.06 : 0.14;

  const hits: MemoryHit[] = [];

  for (const f of opts.facts) {
    const s = overlapScore(q, f.content);
    if (s > 0) hits.push({ source: 'fact', text: f.content, at: f.at, score: s * timeWeight(f.at) * 1.4 });
  }

  for (const d of opts.diary) {
    const text = `${d.title}｜${d.thought}${d.comment ? `｜评论：${d.comment}` : ''}`;
    const s = overlapScore(q, text);
    if (s > 0) {
      hits.push({
        source: 'event',
        text: `看了《${d.title}》，你的评价是「${d.thought}」`,
        at: d.at,
        score: s * timeWeight(d.at) * 1.0,
      });
    }
  }

  for (const c of opts.chatEvents) {
    const s = overlapScore(q, c.text);
    if (s > 0) {
      hits.push({
        source: 'chat',
        text: `他跟你说过：「${c.text}」`,
        at: c.at,
        score: s * timeWeight(c.at) * 1.2,
      });
    }
  }

  return hits
    .filter((h) => h.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  if (days < 30) return `${Math.floor(days / 7)} 周前`;
  return `${d.getMonth() + 1} 月`;
}

/** 拼成注入 system prompt 的一段。没有命中就返回空串。 */
export function buildRecallBlock(hits: MemoryHit[]): string {
  if (hits.length === 0) return '';
  const lines = hits.map((h) => `- ${h.at ? dayLabel(h.at) + '，' : ''}${h.text}`);
  return `

## 你想起来的事
这些是你自己记着的，不是他刚说的。可以自然提起，也可以不提——别硬塞，别说成"根据记录"。
${lines.join('\n')}`;
}

/** 用户是不是在问「你还记得」——这种时候要放宽检索。 */
export function asksForMemory(text: string): boolean {
  return /(记得|还记得|以前|上次|之前说过|我跟你说过|你忘|不是说过)/.test(text);
}
