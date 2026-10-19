import { invoke } from '@tauri-apps/api/core';

export interface BiliVideo {
  bvid: string;
  aid: number;
  title: string;
  owner: string;
  tname: string;
  desc: string;
  view: number;
  danmaku: number;
  reply: number;
  duration: number;
  cid: number;
}

export interface BiliComment {
  user: string;
  message: string;
  like: number;
  mid: number;
  rpid: number;
}

export async function fetchPopular(ps = 10): Promise<BiliVideo[]> {
  return invoke<BiliVideo[]>('bili_popular', { ps });
}

/** 关键词搜索。走 wbi 签名，能精准找到 AI 相关内容，分区排行里几乎没有。 */
export async function searchVideos(keyword: string, num = 8): Promise<BiliVideo[]> {
  return invoke<BiliVideo[]>('bili_search', { keyword, num });
}

/** 分区排行榜，用来凑她的「个人首页」 */
export async function fetchRanking(rid: number, ps = 8): Promise<BiliVideo[]> {
  return invoke<BiliVideo[]>('bili_ranking', { rid, ps });
}

export async function fetchVideo(bvid: string): Promise<BiliVideo> {
  return invoke<BiliVideo>('bili_video', { bvid });
}

export async function fetchComments(aid: number, ps = 5): Promise<BiliComment[]> {
  return invoke<BiliComment[]>('bili_comments', { aid, ps });
}

/** 字幕全文，未登录或视频没字幕时返回 null */
export async function fetchSubtitle(aid: number, cid: number): Promise<string | null> {
  return invoke<string | null>('bili_subtitle', { aid, cid });
}

/** 第一段弹幕，不需要登录 */
export async function fetchDanmaku(cid: number): Promise<string[]> {
  return invoke<string[]>('bili_danmaku', { cid });
}

/** 读某条评论下面的楼中楼 */
export async function fetchRepliesOf(aid: number, root: number): Promise<BiliComment[]> {
  return invoke<BiliComment[]>('bili_replies_of', { aid, root });
}

/** 反查自己在这个视频下最新一条评论的 rpid（补录用） */
export async function findMyComment(aid: number, mid: number): Promise<number> {
  return invoke<number>('bili_find_my_comment', { aid, mid });
}

/** 在楼中楼里回某个人 */
export async function replyTo(
  aid: number,
  root: number,
  parent: number,
  message: string,
): Promise<{ ok: boolean; code: number; message: string; rpid: number }> {
  return invoke('bili_reply_to', { aid, root, parent, message });
}

export function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatCount(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)}亿`;
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)}万`;
  return String(n);
}
