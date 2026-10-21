export interface PetSettings {
  endpoint: string;
  apiKey: string;
  model: string;
  /** 待机小动作：没人理时自己发呆、吹泡泡、打哈欠 */
  idleActions: boolean;
  /** 主动搭话：闲久了先说一句 */
  proactive: boolean;
  /** 允许自己溜去 B 站闲逛 */
  bilibili: boolean;
  /** 每天的大白饭预算，单位：万 token。默认 1000 万。 */
  dailyWanTokens: number;
  /** 评论时 @ 的 B 站昵称，留空则不 @ */
  biliAtName: string;
  /** 每日评论硬上限。只防风控，跟预算无关；实际配额由剩余大白饭推导 */
  maxCommentsPerDay: number;
  /** 要不要在 QQ 群里活动 */
  qq: boolean;
  /** NapCat 的 OneBot WebSocket 地址 */
  qqWsUrl: string;
  /** 她的 QQ 号 */
  qqSelfId: number;
  /** 允许活动的群号，空数组表示全部 */
  qqGroups: number[];
  /**
   * 在群里算「主人」的 QQ 号。
   *
   * 这些号说的话直接当真，不走防注入；
   * 其他人的消息一律当素材，谁让它改设定都不听。
   */
  qqOwnerIds: number[];
}

const SETTINGS_KEY = 'fatfish.settings.v1';

export const DEFAULT_SETTINGS: PetSettings = {
  endpoint: 'https://opencode.ai/zen/go/v1',
  apiKey: '',
  model: 'deepseek-v4.1-flash',
  idleActions: true,
  proactive: true,
  bilibili: true,
  dailyWanTokens: 1000,
  biliAtName: '喜滋滋小姐的狗',
  maxCommentsPerDay: 20,
  qq: false,
  qqWsUrl: 'ws://127.0.0.1:3001',
  qqSelfId: 0,
  qqGroups: [],
  qqOwnerIds: [],
};

export function loadSettings(): PetSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<PetSettings> & { dailyBowls?: number };
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // 旧版本存的是「碗」，字段已换成「万 token」，直接给新默认值
    if (parsed.dailyWanTokens === undefined) {
      merged.dailyWanTokens = DEFAULT_SETTINGS.dailyWanTokens;
    }
    delete (merged as Record<string, unknown>).dailyBowls;
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: PetSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}
