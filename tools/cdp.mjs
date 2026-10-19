#!/usr/bin/env node
/**
 * 通过 WebView2 远程调试协议操作桌宠，全程不动系统鼠标。
 *
 * 用法：
 *   node tools/cdp.mjs eval "localStorage.getItem('fatfish.settings.v1')"
 *   node tools/cdp.mjs shot shots/x.png
 *   node tools/cdp.mjs json            # 列出可连接的 page
 */

const PORT = process.env.CDP_PORT ?? '9222';
const BASE = `http://127.0.0.1:${PORT}`;

async function listPages() {
  const res = await fetch(`${BASE}/json`);
  if (!res.ok) throw new Error(`CDP 列表不可用: HTTP ${res.status}`);
  return res.json();
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const pending = new Map();

    ws.addEventListener('open', () => resolve({ ws, send }));
    ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败: ${e?.message ?? 'unknown'}`)));
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { resolve: r, reject: j } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) j(new Error(JSON.stringify(msg.error)));
        else r(msg.result);
      }
    });

    function send(method, params = {}) {
      return new Promise((r, j) => {
        const mid = ++id;
        pending.set(mid, { resolve: r, reject: j });
        ws.send(JSON.stringify({ id: mid, method, params }));
      });
    }
  });
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  const pages = await listPages();

  if (cmd === 'json') {
    console.log(JSON.stringify(pages.map((p) => ({ type: p.type, url: p.url, title: p.title })), null, 2));
    return;
  }

  const page = pages.find((p) => p.type === 'page' && p.url.includes('127.0.0.1:1420')) ?? pages.find((p) => p.type === 'page');
  if (!page) throw new Error('没有找到可连接的页面');

  const { ws, send } = await connect(page.webSocketDebuggerUrl);
  await send('Runtime.enable');

  if (cmd === 'eval') {
    const expr = args.join(' ');
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { return (${expr}); })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      console.error('EXCEPTION:', result.exceptionDetails.text, result.exceptionDetails.exception?.description ?? '');
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify(result.result?.value ?? null, null, 2));
    }
  } else if (cmd === 'shot') {
    const out = args[0] ?? 'shot.png';
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    const fs = await import('node:fs');
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
    console.log('saved', out);
  } else if (cmd === 'log') {
    // 读取页面里累积的 console 输出（需要在页面侧有 hook，见 inject-log）
    const result = await send('Runtime.evaluate', {
      expression: 'JSON.stringify(window.__petLogs ?? [])',
      returnByValue: true,
    });
    console.log(result.result?.value ?? '[]');
  } else {
    console.error('未知命令。可用: eval | shot | json | log');
    process.exitCode = 1;
  }

  ws.close();
}

main().catch((e) => {
  console.error('ERROR:', e.message);
  process.exit(1);
});
