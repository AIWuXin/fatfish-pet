/**
 * QQ（OneBot v11）客户端。
 *
 * NapCat 挂在 QQ 上，对外提供 OneBot 协议：
 * WebSocket 双向通信，收到的消息和发出的事件都走这一条连接。
 *
 * 为什么不用 Rust 侧连：WebView 原生支持 WebSocket，
 * 而且消息处理逻辑（判断要不要接话、怎么接）本来就是前端的活，
 * 绕一圈到 Rust 再回来没有任何好处。
 */

export interface QqSegment {
  type: string;
  data?: Record<string, unknown>;
}

export interface QqMessage {
  messageId: number;
  groupId: number;
  userId: number;
  nickname: string;
  /** 纯文本内容（已把 at/表情 之类还原成可读形式） */
  text: string;
  /** 有没有人 @ 她 */
  atMe: boolean;
  atOthers: boolean;
  time: number;
  selfId: number;
}

export interface QqConfig {
  wsUrl: string;
  selfId: number;
  /** 只在这些群里活动。空数组表示不限制（不推荐） */
  allowedGroups: number[];
}

type Listener = (msg: QqMessage) => void;
type StatusListener = (connected: boolean, info?: string) => void;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: number;
}

const REQUEST_TIMEOUT = 10_000;

/**
 * OneBot 客户端。
 *
 * 只做三件事：连接、收群消息、发群消息。
 * 判断「要不要接话」是上层的事，这里保持纯粹。
 */
export class QqClient {
  private ws: WebSocket | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<Listener>();
  private statusListeners = new Set<StatusListener>();
  private reconnectTimer = 0;
  private closed = false;
  private connected = false;
  /** 自己的昵称，@ 解析不出 QQ 号时用来兜底认人 */
  private selfName = '';

  constructor(private cfg: QqConfig) {}

  get selfId(): number {
    return this.cfg.selfId;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  onMessage(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onStatus(fn: StatusListener): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  connect(): void {
    this.closed = false;
    this.open();
  }

  private open(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.wsUrl);
    } catch (e) {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.connected = true;
      this.emitStatus(true);
      // 拉一下自己的昵称，@ 兜底要用
      void this.call('get_login_info')
        .then((d) => {
          const info = d as Record<string, unknown> | null;
          if (info && typeof info.nickname === 'string') this.selfName = info.nickname;
        })
        .catch(() => {
          /* 拿不到就算了，还有硬编码的兜底 */
        });
    };

    ws.onclose = () => {
      const wasConnected = this.connected;
      this.connected = false;
      if (wasConnected) this.emitStatus(false, '连接断开');
      this.failAllPending('连接已断开');
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      this.emitStatus(false, '连接出错');
    };

    ws.onmessage = (ev) => {
      let data: unknown;
      try {
        data = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      this.dispatch(data as Record<string, unknown>);
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = 0;
      if (!this.closed) this.open();
    }, 8000);
  }

  private emitStatus(ok: boolean, info?: string): void {
    for (const fn of this.statusListeners) {
      try {
        fn(ok, info);
      } catch {
        /* 监听器自己出错不该影响连接 */
      }
    }
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private dispatch(raw: Record<string, unknown>): void {
    // API 响应（带 echo）
    const echo = raw.echo;
    if (echo !== undefined && typeof echo === 'number') {
      const p = this.pending.get(echo);
      if (p) {
        this.pending.delete(echo);
        window.clearTimeout(p.timer);
        if (raw.status === 'failed' || raw.retcode !== 0) {
          p.reject(new Error(String(raw.wording ?? raw.message ?? 'OneBot 请求失败')));
        } else {
          p.resolve(raw.data);
        }
      }
      return;
    }

    // 事件上报
    if (raw.post_type === 'message' && raw.message_type === 'group') {
      const msg = this.parseGroupMessage(raw);
      if (!msg) return;
      if (this.cfg.allowedGroups.length > 0 && !this.cfg.allowedGroups.includes(msg.groupId)) return;
      for (const fn of this.listeners) {
        try {
          fn(msg);
        } catch {
          /* 单个监听器出错不影响其他 */
        }
      }
    }
  }

  private parseGroupMessage(raw: Record<string, unknown>): QqMessage | null {
    const segments = raw.message;
    if (!Array.isArray(segments)) return null;

    let text = '';
    let atMe = false;
    let atOthers = false;
    let atUnknown = '';

    for (const seg of segments as QqSegment[]) {
      if (!seg || typeof seg !== 'object') continue;
      if (seg.type === 'text') {
        text += String((seg.data as Record<string, unknown>)?.text ?? '');
      } else if (seg.type === 'at') {
        const d = (seg.data ?? {}) as Record<string, unknown>;
        const qq = Number(d.qq ?? 0);
        if (qq === this.cfg.selfId) {
          atMe = true;
        } else if (qq === 0 || d.qq === 'all') {
          // NapCat 有时解析不出被 @ 的人（qq 给 0），先把名片记下来
          atUnknown = String(d.name ?? '');
          if (d.qq === 'all') atOthers = true;
        } else {
          atOthers = true;
        }
      } else if (seg.type === 'face') {
        text += '[表情]';
      } else if (seg.type === 'image') {
        text += '[图片]';
      }
    }

    // 兜底：@ 没带 QQ 号时，用她的昵称/群名片去认
    if (!atMe && atUnknown) {
      if (atUnknown === this.selfName || atUnknown.includes('大肥鱼') || /肥鱼|小鱼|鲸鱼/.test(atUnknown)) {
        atMe = true;
      }
    }
    if (!atMe && /[@＠]\s*(是你的)?大肥鱼|[@＠]\s*肥鱼|[@＠]\s*小鱼/.test(text)) {
      atMe = true;
    }

    const sender = (raw.sender ?? {}) as Record<string, unknown>;
    return {
      messageId: Number(raw.message_id ?? 0),
      groupId: Number(raw.group_id ?? 0),
      userId: Number(raw.user_id ?? 0),
      nickname: String(sender.card || sender.nickname || '群友'),
      text: text.trim(),
      atMe,
      atOthers,
      time: Number(raw.time ?? Math.floor(Date.now() / 1000)) * 1000,
      selfId: this.cfg.selfId,
    };
  }

  /** 调一个 OneBot API，等它的响应 */
  private call(action: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error('还没连上 QQ'));
        return;
      }
      const echo = ++this.seq;
      const timer = window.setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error('QQ 没响应'));
      }, REQUEST_TIMEOUT);
      this.pending.set(echo, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify({ action, params, echo }));
      } catch (e) {
        this.pending.delete(echo);
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  async sendGroup(groupId: number, text: string): Promise<void> {
    await this.call('send_group_msg', { group_id: groupId, message: text });
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    await this.call('send_private_msg', { user_id: userId, message: text });
  }

  async getGroups(): Promise<Array<{ groupId: number; name: string }>> {
    const data = (await this.call('get_group_list')) as Array<Record<string, unknown>>;
    if (!Array.isArray(data)) return [];
    return data.map((g) => ({
      groupId: Number(g.group_id ?? 0),
      name: String(g.group_name ?? ''),
    }));
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = 0;
    }
    this.failAllPending('已关闭');
    this.ws?.close();
    this.ws = null;
    this.connected = false;
  }
}
