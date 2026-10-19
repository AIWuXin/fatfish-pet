import { useState } from 'react';
import type { Impression } from '../services/impressions';
import type { MemoryItem } from '../services/memory';
import type { DiaryEntry } from '../services/diary';
import type { ChatEvent } from '../services/recall';

interface MemoryPanelProps {
  impressions: Impression[];
  memories: MemoryItem[];
  diary: DiaryEntry[];
  chatEvents: ChatEvent[];
  onDeleteImpression: (id: string) => void;
  onDeleteMemory: (id: string) => void;
  onClose: () => void;
}

function when(at: number): string {
  const days = Math.floor((Date.now() - at) / 86400000);
  if (days <= 0) {
    const h = Math.floor((Date.now() - at) / 3600000);
    return h <= 0 ? '刚刚' : `${h} 小时前`;
  }
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  return `${Math.floor(days / 30)} 个月前`;
}

function confTone(c: number): string {
  if (c >= 0.75) return 'high';
  if (c >= 0.5) return 'mid';
  return 'low';
}

/**
 * 记忆可视化。
 *
 * 这么排是为了让"合不合理"一眼能看出来：
 * 印象放最上面（最容易出错的是它），每条能展开看证据；
 * 事实是用户明确让她记的，事件是原料。
 */
export function MemoryPanel({
  impressions,
  memories,
  diary,
  chatEvents,
  onDeleteImpression,
  onDeleteMemory,
  onClose,
}: MemoryPanelProps) {
  const [openImp, setOpenImp] = useState<string | null>(null);
  const [tab, setTab] = useState<'tree' | 'timeline'>('tree');

  const events = [
    ...chatEvents.map((c) => ({ at: c.at, kind: '他说' as const, text: c.text })),
    ...diary.map((d) => ({ at: d.at, kind: '她看' as const, text: `《${d.title}》— ${d.thought}` })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div
      className="settings memory-panel"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerUp={(e) => e.stopPropagation()}
    >
      <div className="settings-head">
        <span>她的记忆</span>
        <button className="icon-btn" onClick={onClose} title="关闭">
          ✕
        </button>
      </div>

      <div className="mem-tabs">
        <button className={tab === 'tree' ? 'mem-tab active' : 'mem-tab'} onClick={() => setTab('tree')}>
          分层
        </button>
        <button className={tab === 'timeline' ? 'mem-tab active' : 'mem-tab'} onClick={() => setTab('timeline')}>
          时间线
        </button>
      </div>

      {tab === 'tree' ? (
        <div className="mem-tree">
          {/* M3 印象 */}
          <div className="mem-group">
            <div className="mem-group-title">
              印象 <em>她对你的判断，可能不准</em>
            </div>
            {impressions.length === 0 && <div className="mem-empty">还没有形成任何印象</div>}
            {impressions.map((i) => (
              <div className="mem-node" key={i.id}>
                <div
                  className="mem-row"
                  onClick={() => setOpenImp(openImp === i.id ? null : i.id)}
                >
                  <span className={`mem-dot ${confTone(i.confidence)}`} />
                  <span className="mem-claim">{i.claim}</span>
                  <span className="mem-conf">{Math.round(i.confidence * 100)}%</span>
                  <button
                    className="mem-del"
                    title="这条不对，删掉"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDeleteImpression(i.id);
                    }}
                  >
                    ×
                  </button>
                </div>
                {openImp === i.id && (
                  <div className="mem-evidence">
                    <div className="mem-ev-title">
                      证据 {i.evidence.length} 条 · 形成于 {when(i.formedAt)}
                    </div>
                    {i.evidence.map((e, idx) => (
                      <div className="mem-ev-item" key={idx}>
                        {e}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* M2 事实 */}
          <div className="mem-group">
            <div className="mem-group-title">
              事实 <em>你让她记住的</em>
            </div>
            {memories.length === 0 && <div className="mem-empty">还没有</div>}
            {memories.map((m) => (
              <div className="mem-row" key={m.id}>
                <span className="mem-dot fact" />
                <span className="mem-claim">{m.content}</span>
                <span className="mem-when">{when(m.at)}</span>
                <button className="mem-del" title="删掉" onClick={() => onDeleteMemory(m.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>

          {/* M1 事件 */}
          <div className="mem-group">
            <div className="mem-group-title">
              事件 <em>召回时从这里捞，共 {events.length} 条</em>
            </div>
            {events.slice(0, 12).map((e, idx) => (
              <div className="mem-row" key={idx}>
                <span className="mem-dot event" />
                <span className="mem-claim">
                  <b className="mem-kind">{e.kind}</b> {e.text.slice(0, 40)}
                </span>
                <span className="mem-when">{when(e.at)}</span>
              </div>
            ))}
            {events.length > 12 && <div className="mem-more">还有 {events.length - 12} 条更早的…</div>}
          </div>
        </div>
      ) : (
        <div className="mem-timeline">
          {events.length === 0 && <div className="mem-empty">还没有任何记录</div>}
          {events.slice(0, 40).map((e, idx) => (
            <div className="tl-item" key={idx}>
              <div className="tl-time">{when(e.at)}</div>
              <div className="tl-body">
                <b>{e.kind}</b> {e.text.slice(0, 60)}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mem-foot">
        印象是判断不是事实。觉得哪条不对，点右边的 × 删掉，她下次就不会拿它说话了。
      </div>
    </div>
  );
}
