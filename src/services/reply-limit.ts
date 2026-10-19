/** 每日评论配额。B 站连发会触发验证码（code -352），宁可少发也别刷屏。 */

const KEY = 'fatfish.bili.replylog.v1';

interface ReplyLog {
  date: string;
  count: number;
}

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function loadReplyCount(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return 0;
    const log = JSON.parse(raw) as ReplyLog;
    return log.date === today() ? log.count : 0;
  } catch {
    return 0;
  }
}

export function incReplyCount(): number {
  const next = loadReplyCount() + 1;
  localStorage.setItem(KEY, JSON.stringify({ date: today(), count: next }));
  return next;
}
