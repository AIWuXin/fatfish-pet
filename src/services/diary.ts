/**
 * 她的「日记」：自己干过的事。
 *
 * 逛 B 站、看了什么、什么感想、评论了什么——这些不是对话历史，
 * 是她自己的经历。下次聊天时应该能想起来，而不是每次都一脸空白。
 */

export interface DiaryEntry {
  /** 发生时间 */
  at: number;
  /** 视频标题 */
  title: string;
  bvid: string;
  /** 她自己的评价 */
  thought: string;
  /** 留在评论区的原话，没发就是空 */
  comment: string;
  /** 视频 aid，读回复要用 */
  aid?: number;
  /** 她那条评论的 rpid，用来追踪谁回了她 */
  rpid?: number;
  /** 已经回复过的 rpid，避免同一条回两次 */
  repliedTo?: number[];
}

const KEY = 'fatfish.diary.v1';
const MAX_ENTRIES = 60;
/** 注入 prompt 时只带最近这么多条 */
const INJECT_LIMIT = 8;

export function loadDiary(): DiaryEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as DiaryEntry[]) : [];
  } catch {
    return [];
  }
}

export function updateDiary(at: number, patch: Partial<DiaryEntry>): DiaryEntry[] {
  const next = loadDiary().map((e) => (e.at === at ? { ...e, ...patch } : e));
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function addDiary(entry: Omit<DiaryEntry, 'at'>): DiaryEntry[] {
  const next = [{ ...entry, at: Date.now() }, ...loadDiary()].slice(0, MAX_ENTRIES);
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearDiary(): DiaryEntry[] {
  localStorage.removeItem(KEY);
  return [];
}

function dayLabel(at: number): string {
  const d = new Date(at);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return `今天 ${hhmm}`;
  if (isYesterday) return `昨天 ${hhmm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hhmm}`;
}

/** 拼成注入 system prompt 的一段。没有记录就返回空串。 */
export function buildDiaryBlock(entries: DiaryEntry[]): string {
  if (entries.length === 0) return '';

  const lines = entries
    .slice(0, INJECT_LIMIT)
    .map((e) => {
      const when = dayLabel(e.at);
      const title = e.title.length > 22 ? `${e.title.slice(0, 22)}…` : e.title;
      const base = `- ${when} 在 B 站看了《${title}》，你的评价：${e.thought}`;
      return e.comment ? `${base}；你在评论区留了「${e.comment}」` : base;
    })
    .join('\n');

  return `\n\n## 你自己最近干的事\n这些是你自己刷 B 站时看的，不是鱼片告诉你的。聊天时可以自然提起，但别硬凑。\n${lines}`;
}
