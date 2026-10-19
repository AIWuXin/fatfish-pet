#!/usr/bin/env node
/**
 * 记忆召回端到端测试：先跟她说一件事，隔一轮再问记不记得。
 * 全程 CDP，不动鼠标。
 *
 * 用法：node tools/test-recall.mjs
 */
const BASE = 'http://127.0.0.1:9222';

async function connect() {
  const pages = await (await fetch(`${BASE}/json`)).json();
  const page = pages.find((p) => p.type === 'page' && p.url.includes('1420'));
  if (!page) throw new Error('找不到桌宠页面');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', () => rej(new Error('WS 失败')), { once: true });
  });
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { r, j } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? j(new Error(JSON.stringify(msg.error))) : r(msg.result);
    }
  });
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const mid = ++id;
      pending.set(mid, { r, j });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  return { ws, send };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { ws, send } = await connect();
  await send('Runtime.enable');

  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? 'eval failed');
    return res.result?.value;
  };

  const say = async (text) => {
    await evaluate(`
      const btn = document.querySelectorAll('.dock-btn')[0];
      if (btn) btn.click();
      return true;
    `);
    await sleep(400);
    await evaluate(`
      const ta = document.querySelector('.composer textarea');
      if (!ta) throw new Error('输入框没出来');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return ta.value;
    `);
    await sleep(200);
    await evaluate(`
      const b = document.querySelector('.send-btn');
      if (!b || b.disabled) throw new Error('发送按钮不可用');
      b.click();
      return true;
    `);
  };

  const waitBubble = async (timeoutMs = 40000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await sleep(1000);
      const v = await evaluate(`return (window.__petState && window.__petState.bubble) || '';`);
      if (v && v.length > 0) return v;
    }
    return '';
  };

  console.log('[1] 先告诉她一件事…');
  await say('我最近在搞 VDA 项目，压力挺大的，天天要赶汇报');
  const r1 = await waitBubble();
  console.log('    她：', r1.slice(0, 100));
  await sleep(3000);

  console.log('\n[2] 隔一轮，问她记不记得…');
  await say('你还记得我最近在忙什么吗');
  const r2 = await waitBubble();
  console.log('    她：', r2.slice(0, 160));

  const hits = await evaluate(`
    const events = JSON.parse(localStorage.getItem('fatfish.chat.events.v1') || '[]');
    return JSON.stringify({ chatEvents: events.length, first: events[0] ? events[0].text.slice(0, 40) : null });
  `);
  console.log('\n[3] 本地记录：', hits);

  ws.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
