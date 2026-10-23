/**
 * M3 关系画像：她对你形成的印象。
 *
 * 和事实记忆的区别：
 *   事实是"他说他在搞 VDA 项目"——客观、不会错
 *   印象是"他不太会照顾自己"——主观、可能错、需要证据撑着
 *
 * 所以每条印象都带：
 *   - 至少两条具体证据（没证据的猜测不要）
 *   - 置信度（0–1），新证据上调、反证下调、长期没验证自动衰减
 *   - 允许被推翻：置信度掉到阈值以下就淘汰
 *
 * 故意不做成"用户档案"：只观察习惯、状态、偏好、情绪模式，
 * 不评价性格好坏、不评价能力、不下人格判断。
 */

import { messageText, streamChat, type ChatMessage } from './llm';
import { estimateTokens, recordUsage, remainingTokens, type BudgetState } from './budget';
import { wrapUntrusted } from './untrusted';
import type { PetSettings } from './settings';
import { userUtterances, type ChatEvent } from './recall';
import type { DiaryEntry } from './diary';

export interface Impression {
  id: string;
  /** 一句话结论，主语是"他" */
  claim: string;
  /** 支撑它的事实片段 */
  evidence: string[];
  /** 0–1 */
  confidence: number;
  formedAt: number;
  lastSeenAt: number;
  /**
   * 依据标记。早期版本把她的逛站日记也喂进去过，
   * 推出过「他爱拿鱼的尾巴打比方」这种把她的话算到他头上的印象。
   * 只认 chat-only，旧的直接作废。
   */
  basis: 'chat-only';
}

const KEY = 'fatfish.impressions.v1';

/** 最多留这么多条，多了她会变成在给人写档案 */
const MAX_IMPRESSIONS = 6;
/** 低于这个置信度就不留了 */
const MIN_CONFIDENCE = 0.35;
/** 注入 prompt 时只取最信的几条 */
const INJECT_LIMIT = 3;
const INJECT_MIN = 0.5;

export function loadImpressions(): Impression[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // 丢掉没有 basis 的历史数据（那是用错材料生成的），顺手清掉
    const valid = (arr as Impression[]).filter((i) => i.basis === 'chat-only');
    if (valid.length !== arr.length) {
      localStorage.setItem(KEY, JSON.stringify(valid));
    }
    return valid;
  } catch {
    return [];
  }
}

export function removeImpression(id: string): Impression[] {
  return persist(loadImpressions().filter((i) => i.id !== id));
}

function persist(list: Impression[]): Impression[] {
  const next = list
    .filter((i) => i.confidence >= MIN_CONFIDENCE)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_IMPRESSIONS);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* 存不下就算了 */
  }
  return next;
}

/** 长期没被验证的印象会慢慢淡掉——人也会这样。 */
function decay(list: Impression[]): Impression[] {
  const now = Date.now();
  let changed = false;
  const next = list.map((i) => {
    const months = (now - i.lastSeenAt) / (30 * 86400000);
    if (months < 1.5) return i;
    changed = true;
    return { ...i, confidence: Math.max(0, i.confidence - 0.1 * months) };
  });
  return changed ? persist(next) : list;
}

function extractJson(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const REFLECT_PERSONA = `（系统旁白，不是鱼片说的话）

你要从最近发生的事里，更新你对他形成的印象。

## 什么是"印象"（这条最容易搞错）
印象是**越过事实的判断**，不是复述事实。

| ❌ 这是事实，不是印象 | ✅ 这才是印象 |
|---|---|
| 他最近在忙 VDA 项目 | 他压力大的时候不会主动求助，得问了才说 |
| 他说压力挺大 | 他嘴上说"还行"，通常意味着不太行 |
| 他今天加班到凌晨 | 他作息没规律，而且不觉得这是个问题 |
| 他问过 AI 工具的评测 | 他挑工具比挑车还认真，会自己记小本本 |

判据：**这条如果他自己看到，会"哦，你还真看出来了"** —— 那才是印象。
只是重复他说过的话，就不是。

## 规矩
- ⛔ **只观察**：作息、状态起伏、说话习惯、偏好、情绪模式
- ⛔ **不评价**：不说他懒、笨、能力差、性格有问题；不做人格诊断
- ⛔ **不推测隐私**：不问收入、感情、家庭、健康细节
- 每条印象必须有**至少两条具体证据**（来自给你的材料）。凑不够就别提。
- 说人话，主语用"他"，一句话，不超过 25 字。
- ⭐ evidence 里每条都要是材料里的**原话片段**（可以截取一句话的一部分，但别改写、别概括）。
- 不要跟已有的印象重复或只是换个说法。
- 拿不准的宁可不提。`;

interface ReflectOptions {
  config: PetSettings;
  budget: BudgetState;
  onBudgetChange: (b: BudgetState) => void;
}

/**
 * 跑一次反思：看最近的材料，更新印象。
 * 返回更新后的列表，以及这次改了什么（用于气泡展示）。
 */
export async function reflect(
  opts: ReflectOptions & { chatEvents: ChatEvent[]; diary: DiaryEntry[] },
): Promise<{ list: Impression[]; added: string[]; reinforced: number; starved: boolean }> {
  const current = decay(loadImpressions());

  // 只用他说过的话。
  // 她的逛站日记是「她自己」的评价，拿来推断「他喜欢什么」必然张冠李戴
  // —— 之前就踩过：把她看视频时的感想变成了「他爱拿尾巴打比方」。
  // ① 她的逛站日记是她自己的评价，拿来推断「他喜欢什么」必然张冠李戴
  // ② 压缩摘要是第三人称叙述（"他…你…"），混进来会被当成他刚说的话
  // 两条都踩过：推出过「他爱拿鱼的尾巴打比方」「他调试时连续改13版」。
  const utterances = userUtterances(opts.chatEvents);
  const material = utterances
    .slice(0, 40)
    .map((c) => `[${dayLabel(c.at)}] 他说：${c.text}`)
    .join('\n');

  // 材料太少就不反思——三五句话推不出一个人，只会编。
  // 但之前 100 字 + 1 条原话的门槛偏高，聊了半天也攒不出印象；
  // 降到 80 字 + 2 条原话，仍然要求至少两个片段。
  if (material.length < 80 || utterances.length < 2) {
    return { list: current, added: [], reinforced: 0, starved: false };
  }

  const existing = current.length
    ? current.map((i) => `- id=${i.id}｜${i.claim}（置信度 ${i.confidence.toFixed(2)}，证据 ${i.evidence.length} 条）`).join('\n')
    : '（还没有任何印象）';

  const payload: ChatMessage[] = [
    { role: 'system', content: REFLECT_PERSONA },
    {
      role: 'user',
      content: `## 你已有的印象
${existing}

## 最近的材料
${wrapUntrusted('材料', material, 2600)}

## 要做的事
1. 新材料**支持**某条已有印象 → 输出 {id, delta 正数, evidence}
2. 新材料**反驳**某条已有印象 → 输出 {id, delta 负数, evidence}
3. 形成**新的**印象 → 放进 new

输出严格 JSON：
{"updates":[{"id":"...","delta":0.15,"evidence":"一句话证据"}],"new":[{"claim":"他……","evidence":["证据1","证据2"]}]}

没有可更新的就返回 {"updates":[],"new":[]}。`,
    },
  ];

  const inputCost = payload.reduce((sum, m) => sum + estimateTokens(messageText(m.content)) + 4, 0);
  if (remainingTokens(opts.budget) < inputCost + 200) {
    return { list: current, added: [], reinforced: 0, starved: true };
  }

  let acc = '';
  let usage = 0;
  for await (const ev of streamChat(payload, opts.config)) {
    if (ev.type === 'delta' && ev.content) acc += ev.content;
    else if (ev.type === 'usage') usage = (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
    else if (ev.type === 'error' || ev.type === 'done') break;
  }
  const spent = usage > 0 ? usage : inputCost + estimateTokens(acc);
  if (spent > 0) opts.onBudgetChange(recordUsage(opts.budget, spent));

  (window as unknown as Record<string, unknown>).__reflectDebug = {
    materialLen: material.length,
    utterances: utterances.length,
    raw: acc.slice(0, 500),
  };

  const parsed = extractJson(acc);
  if (!parsed) return { list: current, added: [], reinforced: 0, starved: false };

  const now = Date.now();
  let list = [...current];
  const added: string[] = [];
  let reinforced = 0;

  // 已有印象：按证据调整置信度
  const updates = Array.isArray(parsed.updates) ? (parsed.updates as Array<Record<string, unknown>>) : [];
  for (const u of updates) {
    const id = String(u.id ?? '');
    const delta = Number(u.delta ?? 0);
    const evidence = String(u.evidence ?? '').trim();
    if (!id || !Number.isFinite(delta) || Math.abs(delta) > 0.5) continue;
    list = list.map((i) => {
      if (i.id !== id) return i;
      reinforced += 1;
      return {
        ...i,
        confidence: Math.min(0.95, Math.max(0, i.confidence + delta)),
        lastSeenAt: now,
        evidence: evidence && !i.evidence.includes(evidence) ? [...i.evidence, evidence].slice(-5) : i.evidence,
      };
    });
  }

  // 新印象
  const fresh = Array.isArray(parsed.new) ? (parsed.new as Array<Record<string, unknown>>) : [];
  for (const n of fresh) {
    const claim = String(n.claim ?? '').trim();
    const evidence = Array.isArray(n.evidence)
      ? (n.evidence as unknown[]).map((e) => String(e).trim()).filter(Boolean)
      : [];
    // 证据不足两条的不收——这是防止她瞎猜的唯一硬闸
    if (!claim || claim.length > 40 || evidence.length < 2) continue;
    if (looksBad(claim)) continue;

    // 证据必须能在材料里找到——否则就是它编的，宁可不要
    const flatMaterial = material.replace(/[\s「」""]/g, '');
    const grounded = evidence.filter((e) => {
      const probe = e.replace(/[「」""\s]/g, '');
      if (probe.length < 4) return false;
      // 原样命中，或者头 6 个字能对上（模型偶尔会截断或补标点）
      return flatMaterial.includes(probe) || (probe.length >= 4 && flatMaterial.includes(probe.slice(0, 4)));
    });
    if (grounded.length < 2) continue;

    // 已经有类似的不重复加
    if (list.some((i) => similarity(i.claim, claim) > 0.6)) continue;

    list.push({
      id: `imp_${now}_${Math.random().toString(36).slice(2, 6)}`,
      claim,
      evidence: grounded.slice(0, 4),
      confidence: 0.55,
      formedAt: now,
      lastSeenAt: now,
      basis: 'chat-only',
    });
    added.push(claim);
  }

  return { list: persist(list), added, reinforced, starved: false };
}

/** 明显越界的表述直接拦掉，不靠提示词自觉。 */
function looksBad(claim: string): boolean {
  return /(懒|笨|蠢|废物|没救|有病|抑郁|心理问题|穷|失败|没用|不行|性格差|人品)/.test(claim);
}

function similarity(a: string, b: string): number {
  const setA = new Set(Array.from(a));
  let hit = 0;
  for (const ch of new Set(Array.from(b))) if (setA.has(ch)) hit += 1;
  return hit / Math.max(1, new Set(Array.from(b)).size);
}

function dayLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

/** 拼进 system prompt。只给最有把握的几条，并且明确「这是判断不是事实」。 */
export function buildImpressionBlock(list: Impression[]): string {
  const top = list.filter((i) => i.confidence >= INJECT_MIN).slice(0, INJECT_LIMIT);
  if (top.length === 0) return '';
  return `

## 你对他的印象
这些是你自己观察出来的判断，**不是他说过的事实**，可能不准：
${top.map((i) => `- ${i.claim}`).join('\n')}

用法：偶尔可以顺着这些印象关心一句，但别当成结论说教，也别每次都提。
如果他说的情况跟你印象不符，以他当下说的为准。`;
}
