// 上游健康度探针：直接用 Node 发请求（UTF-8 干净），绕开 Git Bash 把中文按 GBK 发出去的坑
// 用法: node scripts/probe-upstream.mjs
import fs from 'node:fs';
import path from 'node:path';

const CFG = process.env.CONFIG || path.join(process.env.APPDATA, 'Cline Pass Switcher', 'config.json');
const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
const acc = cfg.accounts[cfg.activeAccount] || cfg.accounts[0];
const UP = (process.env.UP_BASE || cfg.upstreamBase || 'https://api.cline.bot/api/v1').replace(/\/+$/, '');
// 也可以用 UP_BASE 指到本机代理（.../v1）来验证代理链路，例如：
//   UP_BASE=http://127.0.0.1:3199/v1 node scripts/probe-upstream.mjs

const MODELS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['cline-pass/deepseek-v4.1-flash', 'cline-pass/kimi-k3', 'cline-pass/glm-5.3-flash'];

// 注意：这是给上游的**真中文**，Node 的 fetch 按 UTF-8 编码，不会再出现乱码
const PROMPTS = [
  { label: 'ASCII ', text: 'Reply with exactly: OK' },
  { label: '中文  ', text: '回答两个字：收到' },
];

async function ask(model, text) {
  const t0 = Date.now();
  try {
    const r = await fetch(UP + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + acc.key },
      body: JSON.stringify({ model, max_tokens: 256, messages: [{ role: 'user', content: text }] }),
    });
    const raw = await r.text();
    let j = null;
    try { j = JSON.parse(raw); } catch {}
    const content = j?.data?.choices?.[0]?.message?.content ?? j?.choices?.[0]?.message?.content ?? null;
    return { ms: Date.now() - t0, status: r.status, content, err: j?.error || (content == null ? raw.slice(0, 100) : null) };
  } catch (e) {
    return { ms: Date.now() - t0, status: 0, content: null, err: e.message };
  }
}

console.log('上游: ' + UP);
console.log('账号: ' + (acc.name || '(未命名)') + '\n');

for (const model of MODELS) {
  for (const p of PROMPTS) {
    const r = await ask(model, p.text);
    const state = r.content ? '✓' : '✗';
    const body = r.content ? JSON.stringify(r.content.slice(0, 60)) : JSON.stringify(r.err);
    console.log(`${state} ${model}  [${p.label}] HTTP ${r.status}  ${r.ms}ms  ${body}`);
  }
}