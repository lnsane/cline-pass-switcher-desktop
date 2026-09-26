// 用 CDP 驱动开发模式的 Electron：截图 + 点击，做界面验收
// 用法: node cdp.mjs <命令> [参数]
//   shot <输出png> [--full]       截图（--full 截整页）
//   viewport <宽> <高>            设定视口与像素比（截图前统一比例用）
//   eval <js>                     在页面里执行表达式
//   targets                       列出可连的页面目标
// 端口: 默认 9222（桌面版开发实例），用 --port=9333 或 CDP_PORT 环境变量指到别的实例
import fs from 'node:fs';

const argv = process.argv.slice(2).filter((a) => {
  if (a.startsWith('--port=')) { process.env.CDP_PORT = a.slice(7); return false; }
  return true;
});
const PORT = Number(process.env.CDP_PORT) || 9222;
const [cmd, ...rest] = argv;

async function targets() {
  const r = await fetch('http://127.0.0.1:' + PORT + '/json/list');
  return r.json();
}

async function connect() {
  const list = await targets();
  const page = list.find((t) => t.type === 'page' && /index\.html/.test(t.url)) || list.find((t) => t.type === 'page');
  if (!page) throw new Error('没找到页面目标: ' + JSON.stringify(list.map((t) => [t.type, t.url])));
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });
  return { send, close: () => ws.close() };
}

const { send } = await connect();

// 整页截图需要的裁剪框：从页面取实际内容高度。
// 不取的话 captureBeyondViewport 会按视口高度截，长页面下半部分丢失。
async function fullClip(send) {
  const r = await send('Runtime.evaluate', {
    expression: 'JSON.stringify({w: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), h: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)})',
    returnByValue: true,
  });
  const { w, h } = JSON.parse(r.result.value);
  return { x: 0, y: 0, width: w, height: h, scale: 1 };
}

if (cmd === 'targets') {
  console.log(JSON.stringify((await targets()).map((t) => ({ type: t.type, url: t.url, title: t.title })), null, 2));
} else if (cmd === 'eval') {
  const expr = rest.join(' ');
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r, null, 2));
} else if (cmd === 'shot') {
  const out = rest[0] || 'shot.png';
  const full = rest.includes('--full');
  // --full 截整页（长页面用），否则只截视口
  const shot = await send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
    ...(full ? { clip: await fullClip(send) } : {}),
  });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('已保存 ' + out);
} else if (cmd === 'viewport') {
  // 调整视口尺寸：截图前统一比例用
  const w = Number(rest[0]) || 1280;
  const h = Number(rest[1]) || 860;
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 2, mobile: false });
  console.log(`视口设为 ${w}x${h} @2x`);
} else {
  console.error('未知命令: ' + cmd);
}

await send('Runtime.evaluate', { expression: '1' }).catch(() => {});
process.exit(0);