/**
 * 从桌面聊天里主动提取长期事实。
 *
 * 之前完全依赖模型在回复末尾自觉输出 [[remember:...]]，
 * 它经常不提，于是「事实」一直是空的。
 * 现在每积累一批用户原话就单独跑一次提取，让模型专心做一件事。
 *
 * 和印象一样，事实必须有原文证据：
 * 模型要给出 evidence，且必须是材料里的原话片段，不能改写。
 */

import { messageText, streamChat, type ChatMessage } from './llm';
import {
  estimateTokens,
  loadBudget,
  recordUsage,
  remainingTokens,
  type BudgetState,
} from './budget';
import { wrapUntrusted } from './untrusted';
import { userUtterances, type ChatEvent } from './recall';
import type { PetSettings } from './settings';

const EXTRACT_PERSONA = `（系统旁白，不是鱼片说的话）

你在整理「大肥鱼」应该长期记住的事。

只提取他明确说过的、长期有效的事实：
- 偏好：喜欢/讨厌什么、习惯用什么
- 计划、项目、目标
- 重要日期、纪念日
- 身体状况、固定作息
- 固定的人际关系

不要提取：
- 一次性的状态（今天累了、刚吃完饭）
- 你的推测或评价
- 外部内容（B 站评论、群聊、视频字幕）
- 已经记过的

每条不超过 40 字，最多 3 条。
只输出 JSON：
{"facts":[{"text":"他喜欢冰美式","evidence":"我最爱喝冰美式"}]}

evidence 必须是材料里的原话片段，至少 4 个字，不能改写。
没有就返回 {"facts":[]}`;

export interface ExtractResult {
  facts: string[];
  starved: boolean;
}

function dayLabel(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days}天前`;
  return `${Math.floor(days / 30)}个月前`;
}

export async function extractFacts(opts: {
  config: PetSettings;
  budget: BudgetState;
  onBudgetChange: (b: BudgetState) => void;
  chatEvents: ChatEvent[];
  existing: string[];
}): Promise<ExtractResult> {
  const utterances = userUtterances(opts.chatEvents).slice(0, 30);
  const material = utterances
    .map((c) => `[${dayLabel(c.at)}] 他说：${c.text}`)
    .join('\n');

  // 太少就不提取，免得把一句「嗯」当成人生规划
  if (material.length < 60 || utterances.length < 3) {
    return { facts: [], starved: false };
  }

  const payload: ChatMessage[] = [
    { role: 'system', content: EXTRACT_PERSONA },
    {
      role: 'user',
      content: `## 已经记过的\n${
        opts.existing.length ? opts.existing.map((m) => `- ${m}`).join('\n') : '（空）'
      }\n\n## 他最近说过的话\n${wrapUntrusted('聊天记录', material, 2600)}\n\n提取值得长期记住的事实。`,
    },
  ];

  const inputCost = payload.reduce(
    (sum, m) => sum + estimateTokens(messageText(m.content)) + 4,
    0,
  );
  if (remainingTokens(opts.budget) < inputCost + 200) {
    return { facts: [], starved: true };
  }

  let acc = '';
  let usage = 0;
  for await (const ev of streamChat(payload, opts.config)) {
    if (ev.type === 'delta' && ev.content) acc += ev.content;
    else if (ev.type === 'usage') usage = (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
    else if (ev.type === 'error' || ev.type === 'done') break;
  }

  const spent = usage > 0 ? usage : inputCost + estimateTokens(acc);
  // 多场景可能同时记账，读最新账本再累加
  if (spent > 0) opts.onBudgetChange(recordUsage(loadBudget(), spent));

  const m = acc.match(/\{[\s\S]*\}/);
  if (!m) return { facts: [], starved: false };

  let parsed: { facts?: Array<{ text?: string; evidence?: string }> };
  try {
    parsed = JSON.parse(m[0]) as typeof parsed;
  } catch {
    return { facts: [], starved: false };
  }

  const flatMaterial = material.replace(/[\s「」""]/g, '');
  const existingHeads = new Set(opts.existing.map((e) => e.slice(0, 12)));
  const out: string[] = [];

  for (const f of Array.isArray(parsed.facts) ? parsed.facts : []) {
    const text = String(f.text ?? '').trim();
    const evidence = String(f.evidence ?? '').trim();
    if (text.length < 2 || text.length > 40) continue;
    if (evidence.length < 4) continue;

    // 证据必须能在原话里找到，否则就是它编的
    const probe = evidence.replace(/[\s「」""]/g, '');
    if (!flatMaterial.includes(probe)) continue;
    if (existingHeads.has(text.slice(0, 12))) continue;
    if (out.some((x) => x.slice(0, 12) === text.slice(0, 12))) continue;

    out.push(text);
    if (out.length >= 3) break;
  }

  return { facts: out, starved: false };
}
