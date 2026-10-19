export interface MemoryItem {
  id: string;
  content: string;
  at: number;
}

const MEMORY_KEY = 'fatfish.memory.v1';
const MAX_ITEMS = 80;

export function loadMemories(): MemoryItem[] {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as MemoryItem[]) : [];
  } catch {
    return [];
  }
}

export function addMemory(content: string): MemoryItem[] {
  const items = loadMemories();
  const trimmed = content.trim();
  if (!trimmed) return items;

  // 完全重复的直接跳过；近似重复（前 20 字相同）也跳过，避免同一句话存十遍
  const head = trimmed.slice(0, 20);
  if (items.some((m) => m.content === trimmed || m.content.slice(0, 20) === head)) {
    return items;
  }

  const next = [{ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, content: trimmed, at: Date.now() }, ...items].slice(
    0,
    MAX_ITEMS,
  );
  localStorage.setItem(MEMORY_KEY, JSON.stringify(next));
  return next;
}

export function removeMemory(id: string): MemoryItem[] {
  const next = loadMemories().filter((m) => m.id !== id);
  localStorage.setItem(MEMORY_KEY, JSON.stringify(next));
  return next;
}

/** 把长期记忆拼进 system prompt。只带最近的 20 条，避免每次对话都把上下文撑爆。 */
export function buildMemoryBlock(items: MemoryItem[]): string {
  if (items.length === 0) return '';
  const lines = items
    .slice(0, 20)
    .map((m) => `- ${m.content}`)
    .join('\n');
  return `\n\n## 你记得的事\n${lines}`;
}
