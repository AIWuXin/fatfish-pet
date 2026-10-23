/**
 * 系统提示词组装器。
 *
 * 之前每处场景各拼一遍，结果就是：加了「生物钟」只加到桌面对话，
 * 群里和私信忘了；加了「主人身份」也只有桌面知道，她就在 QQ 群里
 * 把主人的 B 站昵称当陌生人。
 *
 * 这类漏配必然会再发生，所以把「哪个场景该带什么」收进一处，
 * 由 SCENE_DEFAULTS 明确声明，新增能力只要改这张表。
 */

import { PERSONA, buildIdentityBlock } from './persona';
import { buildMemoryBlock, type MemoryItem } from './memory';
import { buildDiaryBlock, type DiaryEntry } from './diary';
import { buildImpressionBlock, type Impression } from './impressions';
import { buildClockBlock, readClock } from './circadian';
import { buildMoodBlock, loadMood, onReturn } from './mood-state';
import { UNTRUSTED_NOTICE } from './untrusted';

export type Scene = 'chat' | 'proactive' | 'group' | 'dm' | 'browse' | 'reply';

/**
 * 每个场景默认带什么。
 *
 * - clock    时间感：不知道几点，她半夜也会精神抖擞
 * - mood     情绪：没有心情，每次开口都从零开始
 * - identity 主人是谁：不带的话，她在外面会把主人的昵称当陌生人
 * - untrusted 防注入声明：面对外部内容的场景必须有
 * - memory/diary/impressions 记忆三件套：只有直接对话需要全量
 */
const SCENE_DEFAULTS: Record<Scene, {
  clock: boolean;
  mood: boolean;
  identity: boolean;
  untrusted: boolean;
  memory: boolean;
  diary: boolean;
}> = {
  /** 桌面上直接说话：什么都要，记忆全给 */
  chat: { clock: true, mood: true, identity: true, untrusted: false, memory: true, diary: true },
  /** 她主动开口：不需要召回和印象，但要知道现在几点、心情如何 */
  proactive: { clock: true, mood: true, identity: true, untrusted: false, memory: true, diary: true },
  /** QQ 群：外部环境，要有隔离声明；不注入任何私有记忆，也不给日记——
   *  群里说的话不该把桌面上的内容带出去 */
  group: { clock: true, mood: true, identity: true, untrusted: true, memory: false, diary: false },
  /** B 站私信：同上。私信与群聊之间也不共享任何状态 */
  dm: { clock: true, mood: true, identity: true, untrusted: true, memory: false, diary: false },
  /** 逛 B 站挑视频：看的是公开内容，带日记知道最近看过什么 */
  browse: { clock: true, mood: false, identity: false, untrusted: true, memory: false, diary: true },
  /** 回复评论：同上 */
  reply: { clock: true, mood: false, identity: false, untrusted: true, memory: false, diary: false },
};

export interface PromptInput {
  scene: Scene;
  /** 场景专用人格段（GROUP_PERSONA / DM_PERSONA 之类） */
  scenePersona?: string;
  identity?: { real: string; biliName?: string; qqName?: string };
  memories?: MemoryItem[];
  diary?: DiaryEntry[];
  impressions?: Impression[];
  /** 已拼好的召回块 */
  recallBlock?: string;
  /** 已拼好的待跟进块 */
  pendingBlock?: string;
  /** 情绪是否处于「久别抱怨」状态 */
  outburst?: boolean;
  /** 覆盖默认开关 */
  overrides?: Partial<(typeof SCENE_DEFAULTS)[Scene]>;
}

/**
 * 拼出完整的 system prompt。
 *
 * 顺序是有讲究的：先人格、再身份、再记忆，最后才是时间与心情——
 * 越靠后的内容对模型当下的行为影响越大。
 */
export function buildSystemPrompt(input: PromptInput): string {
  const flags = { ...SCENE_DEFAULTS[input.scene], ...(input.overrides ?? {}) };
  const now = Date.now();
  const parts: string[] = [PERSONA];

  if (flags.identity) {
    parts.push(
      buildIdentityBlock(
        input.identity ?? { real: 'wuxin', biliName: undefined, qqName: undefined },
      ),
    );
  }

  if (input.scenePersona) parts.push(input.scenePersona);
  if (flags.untrusted) parts.push(UNTRUSTED_NOTICE);

  if (flags.memory && input.memories && input.memories.length > 0) {
    parts.push(buildMemoryBlock(input.memories));
  }
  if (flags.diary && input.diary && input.diary.length > 0) {
    parts.push(buildDiaryBlock(input.diary));
  }
  if (input.recallBlock) parts.push(input.recallBlock);
  if (input.impressions && input.impressions.length > 0) {
    parts.push(buildImpressionBlock(input.impressions));
  }

  if (flags.clock) parts.push(buildClockBlock(readClock(new Date(now))));
  if (flags.mood) {
    parts.push(buildMoodBlock(onReturn(loadMood(), now), input.outburst ?? false, now));
  }
  if (input.pendingBlock) parts.push(input.pendingBlock);

  return parts.filter(Boolean).join('');
}

/** 调试用：看某个场景到底带了哪些块 */
export function sceneFlags(scene: Scene): string[] {
  return Object.entries(SCENE_DEFAULTS[scene])
    .filter(([, on]) => on)
    .map(([k]) => k);
}
