import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

export interface LLMConfig {
  endpoint: string;
  apiKey: string;
  model: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本，或者多模态数组（文字 + 图片 URL） */
  content: string | ContentPart[];
}

/** 取消息里的纯文本部分。图片 URL 不计入文本 token 估算。 */
export function messageText(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

export interface StreamEvent {
  type: 'delta' | 'done' | 'error' | 'usage';
  content?: string;
  error?: string;
  /** type === 'usage' 时给出本次请求的真实 token 消耗 */
  promptTokens?: number;
  completionTokens?: number;
}

const SESSION_KEY = 'fatfish.session.v1';

/** opencode 网关要求稳定的会话 ID，用于路由和 prompt 缓存。 */
function sessionId(): string {
  let id = localStorage.getItem(SESSION_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, id);
  }
  return id;
}

/** OpenAI 兼容的流式对话。endpoint 只写到 /v1 这一层，路径由这里补。 */
export async function* streamChat(
  messages: ChatMessage[],
  config: LLMConfig,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const base = config.endpoint.replace(/\/+$/, '');
  const url = `${base}/chat/completions`;

  // 没有超时的流式请求会永久占住 GroupWatcher 的 busy 锁，
  // 后续 @ 只能排队，60 秒后过期，看起来就是「没回复」。
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(), 60_000);

  let response: Response;
  try {
    // 走 Tauri 的 HTTP 插件（Rust 侧发请求）：
    // 浏览器 fetch 不允许设置 User-Agent，而 opencode 网关要求客户端自报身份。
    response = await tauriFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
        'User-Agent': 'fatfish-pet/0.1.0',
        'x-opencode-session': sessionId(),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        stream: true,
        temperature: 0.8,
        // 让服务端在流末尾带一条 usage，用真实消耗记账而不是全靠估算
        stream_options: { include_usage: true },
      }),
      signal: signal ?? timeoutController.signal,
    });
  } catch (err) {
    clearTimeout(timeoutTimer);
    yield { type: 'error', error: err instanceof Error ? err.message : '网络错误' };
    return;
  }

  if (!response.ok || !response.body) {
    let detail = `HTTP ${response.status}`;
    try {
      const text = await response.text();
      if (text) detail += `: ${text.slice(0, 300)}`;
    } catch {
      /* 忽略读取失败 */
    }
    yield { type: 'error', error: detail };
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { type: 'done' };
          return;
        }
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (typeof delta === 'string' && delta.length > 0) {
            yield { type: 'delta', content: delta };
          }
          // usage 通常出现在最后一个 chunk（choices 为空）
          if (json.usage) {
            yield {
              type: 'usage',
              promptTokens: json.usage.prompt_tokens ?? 0,
              completionTokens: json.usage.completion_tokens ?? 0,
            };
          }
        } catch {
          // 单行解析失败不致命，继续读下一行
        }
      }
    }
    yield { type: 'done' };
  } catch (err) {
    if (signal?.aborted) {
      yield { type: 'done' };
      return;
    }
    yield { type: 'error', error: err instanceof Error ? err.message : '流读取中断' };
  } finally {
    clearTimeout(timeoutTimer);
  }
}
