import { useCallback, useRef, useState } from 'react';
import { streamChat, type ChatMessage } from '../services/llm';
import { PERSONA, parseReply, stripPartialMarkers } from '../services/persona';
import { buildMemoryBlock, type MemoryItem } from '../services/memory';
import { buildDiaryBlock, type DiaryEntry } from '../services/diary';
import type { PetSettings } from '../services/settings';
import {
  recordUsage,
  remainingTokens,
  estimateTokens,
  STARVED_SUFFIX,
  type BudgetState,
} from '../services/budget';

const MAX_TURNS = 14;

/** 留给输出的余量：没这个数就别开口了 */
const MIN_OUTPUT_TOKENS = 300;

interface UsePetChatOptions {
  config: PetSettings;
  memories: MemoryItem[];
  diary: DiaryEntry[];
  budget: BudgetState;
  onBudgetChange: (next: BudgetState) => void;
  onMood: (mood: string) => void;
  onRemember: (content: string) => void;
  /** 预算不够时回调，由外部决定怎么撒娇 */
  onHungry: () => void;
}

export interface ChatResult {
  text: string;
  ok: boolean;
  /** 预算耗尽被中途掐断 */
  starved?: boolean;
}

function promptTokensOf(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}

export function usePetChat({
  config,
  memories,
  diary,
  budget,
  onBudgetChange,
  onMood,
  onRemember,
  onHungry,
}: UsePetChatOptions) {
  const historyRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [liveText, setLiveText] = useState('');

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setLiveText('');
  }, []);

  /**
   * 统一的请求执行器：管预算、管截断、管记账。
   * 预算不够时立刻停，并在结尾挂一句「我还想吃大白饭」。
   */
  const run = useCallback(
    async (payload: ChatMessage[]): Promise<{ raw: string; starved: boolean; ok: boolean }> => {
      const remaining = remainingTokens(budget);
      const inputCost = promptTokensOf(payload);

      if (remaining < inputCost + MIN_OUTPUT_TOKENS) {
        return { raw: '', starved: true, ok: false };
      }

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setBusy(true);
      setLiveText('');

      let acc = '';
      let starved = false;
      let failed = false;
      let realUsage = 0;

      for await (const ev of streamChat(payload, config, controller.signal)) {
        if (ev.type === 'delta' && ev.content) {
          acc += ev.content;
          setLiveText(stripPartialMarkers(acc));

          // 流式过程中按估算值滚动检查，超了就立刻掐掉
          const spent = inputCost + estimateTokens(acc);
          if (spent > remaining) {
            starved = true;
            controller.abort();
            break;
          }
        } else if (ev.type === 'usage') {
          realUsage = (ev.promptTokens ?? 0) + (ev.completionTokens ?? 0);
        } else if (ev.type === 'error') {
          failed = true;
          break;
        } else if (ev.type === 'done') {
          break;
        }
      }

      setBusy(false);
      setLiveText('');

      // 优先用服务端回的真实 usage，没有就按估算记
      const spent = realUsage > 0 ? realUsage : inputCost + estimateTokens(acc);
      if (spent > 0) onBudgetChange(recordUsage(budget, spent));

      if (failed && !starved) return { raw: '', starved: false, ok: false };
      return { raw: acc, starved, ok: true };
    },
    [budget, config, onBudgetChange],
  );

  const send = useCallback(
    async (input: string): Promise<ChatResult> => {
      const text = input.trim();
      if (!text) return { text: '', ok: false };

      if (!config.apiKey || !config.endpoint || !config.model) {
        return { text: '我还没连上脑子，先去设置里填一下 API。', ok: false };
      }

      const system: ChatMessage = {
        role: 'system',
        content: PERSONA + buildMemoryBlock(memories) + buildDiaryBlock(diary),
      };
      const history = historyRef.current.slice(-MAX_TURNS * 2);
      const payload: ChatMessage[] = [system, ...history, { role: 'user', content: text }];

      const result = await run(payload);

      if (result.starved) {
        onHungry();
        return { text: '（碗空了……我还想吃大白饭）', ok: false, starved: true };
      }
      if (!result.ok) {
        historyRef.current = [...historyRef.current, { role: 'user', content: text }];
        return { text: '脑子卡住了，等下再说。', ok: false };
      }

      const { text: clean, mood, remember } = parseReply(result.raw);
      historyRef.current = [
        ...historyRef.current,
        { role: 'user', content: text },
        { role: 'assistant', content: clean || result.raw },
      ];

      if (mood) onMood(mood);
      if (remember) onRemember(remember);

      const reply = clean || result.raw || '（想了半天，什么也没说）';
      return {
        text: result.starved ? reply + STARVED_SUFFIX : reply,
        ok: true,
        starved: result.starved,
      };
    },
    [config, memories, diary, run, onMood, onRemember, onHungry],
  );

  /**
   * 主动搭话：prompt 是系统旁白，不进对话历史。
   * 她随口说一句，不记得上次自说自话的内容——这样反而更像"随口一提"。
   */
  const speakProactively = useCallback(
    async (hint: string): Promise<string | null> => {
      if (!config.apiKey || !config.endpoint || !config.model) return null;

      const payload: ChatMessage[] = [
        { role: 'system', content: PERSONA + buildMemoryBlock(memories) + buildDiaryBlock(diary) },
        { role: 'user', content: hint },
      ];

      const result = await run(payload);
      if (result.starved) {
        onHungry();
        return null;
      }
      if (!result.ok || !result.raw) return null;

      const { text, mood, remember } = parseReply(result.raw);
      if (mood) onMood(mood);
      if (remember) onRemember(remember);
      return !result.starved ? text || null : (text || '') + STARVED_SUFFIX;
    },
    [config, memories, diary, run, onMood, onRemember, onHungry],
  );

  const clear = useCallback(() => {
    historyRef.current = [];
  }, []);

  return { send, stop, clear, speakProactively, busy, liveText };
}
