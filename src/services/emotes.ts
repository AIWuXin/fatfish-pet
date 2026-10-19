/**
 * B 站评论表情。
 *
 * 评论正文里写 `[doge]` 这样的标记，B 站会渲染成图。写错名字就只是纯文本。
 * 所以只给模型一份**确认存在**的短名单，不给全套四百多个——既省 token 又不至于乱写。
 */

import { invoke } from '@tauri-apps/api/core';

/** 常用且辨识度高的那批。名字必须和 B 站返回的 text 完全一致。 */
const WANTED = [
  '[doge]',
  '[笑哭]',
  '[喜极而泣]',
  '[星星眼]',
  '[吃瓜]',
  '[打call]',
  '[大哭]',
  '[滑稽]',
  '[呲牙]',
  '[调皮]',
  '[awsl]',
  '[酸了]',
  '[妙啊]',
  '[捂脸]',
  '[偷笑]',
  '[无语]',
  '[热词系列_可爱捏]',
  '[热词系列_有点意思]',
  '[热词系列_什么叫惊喜]',
  '[热词系列_我真棒]',
  '[tv_doge]',
  '[tv_坏笑]',
];

const CACHE_KEY = 'fatfish.bili.emotes.v1';

/** 拉一次并缓存，返回实际可用的那部分 */
export async function loadEmotes(): Promise<string[]> {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      const arr = JSON.parse(cached) as string[];
      if (Array.isArray(arr) && arr.length > 0) return arr;
    }
  } catch {
    /* 缓存坏了就重新拉 */
  }

  try {
    const all = await invoke<string[]>('bili_emotes');
    const available = new Set(all);
    const picked = WANTED.filter((e) => available.has(e));
    if (picked.length > 0) {
      localStorage.setItem(CACHE_KEY, JSON.stringify(picked));
    }
    return picked;
  } catch {
    return [];
  }
}

/** 拼进提示词的一小段。没有可用表情时返回空串。 */
export function emoteHint(emotes: string[]): string {
  if (emotes.length === 0) return '';
  return `

## 可以用表情
评论里写下面这些标记，B 站会渲染成表情图（**只能用这些，写别的会变成纯文字**）：
${emotes.join(' ')}

用法：
- 一条最多 1–2 个，放在情绪最强的地方，用多了像贴纸糊脸
- ⛔ **只能用上面列出的这些，一个字都不能改**。自己造一个（比如 [害羞]、[可爱]）不会渲染成图，
  只会留下一对方括号，很难看`;
}

/**
 * 处理正文里的表情标记。
 *
 * 三种情况：
 *   1. 半角 `[doge]` 且在名单里 → 原样（B 站会渲染成图）
 *   2. 半角/全角括号但名单外（`[害羞]` `【害羞】`）→ 降级成文字 `（害羞）`，
 *      不删——那是她把情绪写在那儿了
 *   3. 全角括号里的名字在名单里（`【doge】`）→ 换成半角 `[doge]`，
 *      否则 B 站不认，会原样显示成一对方括号
 *
 * 另外要清掉空的 `【】` `[]` —— 模型偶尔会随手补一对空的，渲染出来就是两个框。
 */
export function sanitizeEmotes(text: string, allowed: string[]): string {
  if (!text) return '';
  const set = new Set(allowed);

  // 全角括号：先把「名字本身合法」的救回半角，其余降级成文字
  const fixed = text.replace(/【([^】\n]{1,20})】/g, (_m, inner: string) => {
    const half = `[${inner}]`;
    if (set.has(half)) return half;
    const label = inner.replace(/^(热词系列_|tv_|doge_)/, '');
    return label ? `（${label}）` : '';
  });

  return fixed
    .replace(/\[([^\]\n]{1,20})\]/g, (m, inner: string) => {
      if (set.has(m)) return m;
      const label = inner.replace(/^(热词系列_|tv_|doge_)/, '');
      return label ? `（${label}）` : '';
    })
    // 空括号对和小括号残留
    .replace(/[【】]{2}|\[\]|\(\s*\)|（\s*）/g, '')
    .replace(/[ 	]{2,}/g, ' ')
    .replace(/[ 	]+([，。！？、）])/g, '$1')
    .trim();
}

/** 清理模型偶尔会漏进正文的 mood 标记。 */
export function stripMoodLeak(text: string): string {
  return text
    .replace(/[[\(（【]?[\s]*mood[\s]*[:：=][\s]*[a-zA-Z_-]+[\]）)】]?/gi, '')
    .replace(/[\s]{2,}/g, ' ')
    .trim();
}
