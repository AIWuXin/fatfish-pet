import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { PetSettings } from '../services/settings';
import type { MemoryItem } from '../services/memory';
import type { DiaryEntry } from '../services/diary';
import type { Impression } from '../services/impressions';

interface SettingsPanelProps {
  settings: PetSettings;
  memories: MemoryItem[];
  diary: DiaryEntry[];
  impressions: Impression[];
  onSave: (s: PetSettings) => void;
  onRemoveMemory: (id: string) => void;
  onClose: () => void;
  biliLoggedIn: boolean;
  remainingTokens: number;
  totalTokens: number;
  quotaLeft: number;
  avgBrowseCost: number;
  onOpenBiliLogin: () => void;
  onOpenMemory: () => void;
  onBiliLogout: () => void;
}

export function SettingsPanel({
  settings,
  memories,
  diary,
  impressions,
  onSave,
  onRemoveMemory,
  onClose,
  biliLoggedIn,
  remainingTokens,
  totalTokens,
  quotaLeft,
  avgBrowseCost,
  onOpenBiliLogin,
  onOpenMemory,
  onBiliLogout,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [importNote, setImportNote] = useState<string | null>(null);

  const handleImport = async () => {
    try {
      const cfg = await invoke<PetSettings & { source?: string }>('import_cli_config');
      setDraft((prev) => ({ ...prev, endpoint: cfg.endpoint, apiKey: cfg.apiKey, model: cfg.model }));
      setImportNote(`已从 ${cfg.source ?? '本机配置'} 导入`);
    } catch (err) {
      setImportNote(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div
      className="settings"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="settings-head">
        <span>设置</span>
        <div>
          <button className="text-btn" onClick={handleImport}>
            从本机导入
          </button>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ✕
          </button>
        </div>
      </div>
      {importNote && <div className="import-note">{importNote}</div>}

      <label className="field">
        <span>接口地址</span>
        <input
          value={draft.endpoint}
          placeholder="https://api.deepseek.com/v1"
          onChange={(e) => setDraft({ ...draft, endpoint: e.target.value })}
        />
      </label>

      <label className="field">
        <span>模型</span>
        <input
          value={draft.model}
          placeholder="deepseek-chat"
          onChange={(e) => setDraft({ ...draft, model: e.target.value })}
        />
      </label>

      <label className="field">
        <span>API Key</span>
        <input
          type="password"
          value={draft.apiKey}
          placeholder="sk-..."
          onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
        />
      </label>

      <div className="settings-behavior">
        <div className="switch-title">自己待着的时候</div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.idleActions}
            onChange={(e) => setDraft({ ...draft, idleActions: e.target.checked })}
          />
          <span>
            待机小动作
            <em>没人理时自己发呆、吹泡泡、打哈欠</em>
          </span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.proactive}
            onChange={(e) => setDraft({ ...draft, proactive: e.target.checked })}
          />
          <span>
            主动找你说话
            <em>闲久了会先开口，深夜自动降低频率</em>
          </span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.bilibili}
            onChange={(e) => setDraft({ ...draft, bilibili: e.target.checked })}
          />
          <span>
            自己逛 B 站
            <em>无聊时溜去看视频，看完会跟你念叨</em>
          </span>
        </label>
      </div>

      <div className="settings-behavior">
        <div className="switch-title">大白饭（token 预算）</div>
        <label className="field compact">
          <span>
            每天预算（万 token）
            <em className="budget-left">
              今天还剩 {(remainingTokens / 10_000).toFixed(1)} 万 / 共 {(totalTokens / 10_000).toFixed(0)} 万
              {' · '}还能逛 {quotaLeft} 次（单次约 {avgBrowseCost} token）
            </em>
          </span>
          <input
            type="number"
            min={0}
            max={10000000}
            step={100}
            value={draft.dailyWanTokens}
            onChange={(e) => setDraft({ ...draft, dailyWanTokens: Number(e.target.value) || 0 })}
          />
        </label>
        <label className="field compact">
          <span>评论时 @ 谁（留空则不 @）</span>
          <input
            value={draft.biliAtName}
            placeholder="你的 B 站昵称"
            onChange={(e) => setDraft({ ...draft, biliAtName: e.target.value })}
          />
        </label>
        <label className="field compact">
          <span>
            每日评论硬上限
            <em className="budget-left">只防风控，跟预算无关。实际配额由剩余大白饭推导</em>
          </span>
          <input
            type="number"
            min={0}
            max={20}
            value={draft.maxCommentsPerDay}
            onChange={(e) => setDraft({ ...draft, maxCommentsPerDay: Number(e.target.value) || 0 })}
          />
        </label>
        <div className="bili-row">
          <span className="bili-state">{biliLoggedIn ? 'B 站：已登录' : 'B 站：未登录'}</span>
          {biliLoggedIn ? (
            <button className="text-btn" onClick={onBiliLogout}>
              退出登录
            </button>
          ) : (
            <button className="text-btn" onClick={onOpenBiliLogin}>
              扫码登录
            </button>
          )}
        </div>
        {!biliLoggedIn && (
          <div className="bili-hint">没登录也能逛，只是看不了、发不了评论。</div>
        )}
      </div>

      {/* QQ 群 */}
      <div className="settings-block">
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.qq}
            onChange={(e) => setDraft({ ...draft, qq: e.target.checked })}
          />
          <span>在 QQ 群里聊天</span>
        </label>
        <div className="bili-hint">
          需要先在本机跑 NapCat（OneBot 接口）。她潜水时会每半小时翻一遍群消息，
          看到提到自己的就接一句，之后活跃三分钟再潜水。
        </div>
        {draft.qq && (
          <>
            <label className="field compact">
              <span>她的 QQ 号</span>
              <input
                value={draft.qqSelfId || ''}
                placeholder="3576356769"
                onChange={(e) => setDraft({ ...draft, qqSelfId: Number(e.target.value) || 0 })}
              />
            </label>
            <label className="field compact">
              <span>
                允许的群号
                <em className="budget-left">逗号分隔，留空表示所有群</em>
              </span>
              <input
                value={(draft.qqGroups ?? []).join(',')}
                placeholder="575138626"
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    qqGroups: e.target.value
                      .split(',')
                      .map((x) => Number(x.trim()))
                      .filter((x) => Number.isFinite(x) && x > 0),
                  })
                }
              />
            </label>
            <label className="field compact">
              <span>NapCat 地址</span>
              <input
                value={draft.qqWsUrl}
                placeholder="ws://127.0.0.1:3001"
                onChange={(e) => setDraft({ ...draft, qqWsUrl: e.target.value })}
              />
            </label>
          </>
        )}
      </div>

      {impressions.length > 0 && (
        <div className="settings-memories">
          <div className="memories-title">她对你的印象（{impressions.length}）</div>
          <div className="memories-list">
            {impressions.map((i) => (
              <div className="memory-item impression-item" key={i.id}>
                <span title={`证据：${i.evidence.join(' / ')}`}>
                  {i.claim}
                  <em className="conf">{Math.round(i.confidence * 100)}%</em>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="settings-memories">
        <div className="memories-title">她记得的事（{memories.length}）</div>
        {memories.length === 0 && <div className="memories-empty">还没有。跟她聊点你自己的事吧。</div>}
        <div className="memories-list">
          {memories.slice(0, 30).map((m) => (
            <div className="memory-item" key={m.id}>
              <span title={m.content}>{m.content}</span>
              <button className="icon-btn tiny" onClick={() => onRemoveMemory(m.id)} title="忘掉">
                ✕
              </button>
            </div>
          ))}
        </div>
      </div>

      {diary.length > 0 && (
        <div className="settings-memories">
          <div className="memories-title">她最近自己干的事（{diary.length}）</div>
          <div className="memories-list">
            {diary.slice(0, 6).map((d) => (
              <div className="memory-item diary-item" key={`${d.at}-${d.bvid}`}>
                <span title={`${d.title}
${d.thought}`}>
                  《{d.title.slice(0, 12)}》{d.thought.slice(0, 14)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <button className="memory-entry" onClick={onOpenMemory}>
        <span>她的记忆</span>
        <em>
          印象 {impressions.length} · 事实 {memories.length} · 事件 {diary.length + 0}
        </em>
      </button>

      <div className="settings-actions">
        <button
          className="primary-btn"
          onClick={() => {
            onSave(draft);
            onClose();
          }}
        >
          保存
        </button>
      </div>
    </div>
  );
}
