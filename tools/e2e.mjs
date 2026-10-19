#!/usr/bin/env node
/**
 * 无头端到端：注入配置 → 刷新 → 输入 → 发送 → 读回复 → 截图。
 * 全程只走 CDP，不碰系统鼠标和键盘。
 *
 * 用法：node tools/e2e.mjs "你好呀"
 */
import fs from 'node:fs';
import path from 'node:path';

const PORT = process.env.CDP_PORT ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

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

async function evaluate(send, expression) {
  const res = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
  }
  return res.result?.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const message = process.argv[2] ?? '你好呀，你叫什么名字？';
  const settingsPath = process.argv[3];

  const { ws, send } = await connect();
  await send('Runtime.enable');
  await send('Page.enable');

  // 1. 注入配置（如果给了配置文件）
  if (settingsPath && fs.existsSync(settingsPath)) {
    const cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    await evaluate(
      send,
      `localStorage.setItem('fatfish.settings.v1', ${JSON.stringify(JSON.stringify(cfg))}); return true;`,
    );
    console.log('[1] 配置已写入 localStorage');
    await send('Page.reload', { ignoreCache: true });
    await sleep(4000);
  } else {
    console.log('[1] 跳过配置注入');
  }

  // 2. 等模型就绪
  for (let i = 0; i < 40; i++) {
    const ready = await evaluate(send, `return !document.querySelector('.pet-loading');`);
    if (ready) break;
    await sleep(500);
  }
  console.log('[2] 页面就绪');

  // 3. 打开输入框（点击 dock 第一个按钮）
  await evaluate(
    send,
    `const btn = document.querySelectorAll('.dock-btn')[0];
     if (!btn) throw new Error('dock 按钮不存在');
     btn.click();
     return true;`,
  );
  await sleep(400);

  // 4. 填入文本并触发 React onChange
  const filled = await evaluate(
    send,
    `const ta = document.querySelector('.composer textarea');
     if (!ta) throw new Error('输入框不存在');
     const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
     setter.call(ta, ${JSON.stringify(message)});
     ta.dispatchEvent(new Event('input', { bubbles: true }));
     return ta.value;`,
  );
  console.log('[3] 已输入：', filled);

  // 5. 点发送
  await sleep(200);
  await evaluate(
    send,
    `const btn = document.querySelector('.send-btn');
     if (!btn) throw new Error('发送按钮不存在');
     if (btn.disabled) throw new Error('发送按钮处于禁用态');
     btn.click();
     return true;`,
  );
  console.log('[4] 已发送，等待回复…');

  // 6. 轮询气泡文本
  let text = '';
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    text = (await evaluate(send, `const el = document.querySelector('.bubble'); return el ? el.textContent : '';`)) ?? '';
    if (text && !text.includes('正在')) break;
  }
  console.log('[5] 气泡内容：', JSON.stringify(text));

  // 7. 截图
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  const out = path.resolve('shots/e2e.png');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('[6] 截图：', out);

  ws.close();
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
