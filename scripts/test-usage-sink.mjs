// 用量「实时推送」的端到端验证
//
// 为什么必须单独测：setUsageSink 是引擎内部的回调，单元测试碰不到 ——
// 它是「实时」这个需求的全部实现。要证明的是：**真的发生一次请求之后，
// 回调会被调用**，而不是只在接口层面看起来对。
//
// 不需要真实上游 key：请求会因未授权失败，但失败同样要记账（真实账单里
// 失败请求也是要留痕的），所以这条路能覆盖到 recordUsage → sink。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++; failures.push(label);
}
function eq(a, b, label) {
  if (a === b) { pass++; return; }
  fail++; failures.push(`${label}\n     期望: ${JSON.stringify(b)}\n     实得: ${JSON.stringify(a)}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sink-'));
process.env.DATA_DIR = tmp;

const mod = await import('../src/main/engine/engine.js');

// 监听：所有被推送过来的记录
const pushed = [];
mod.setUsageSink((e) => pushed.push(e));

// 用一个不常用的端口，避开正在运行的实例
const PORT = 3411;
const started = await mod.start({ host: '127.0.0.1', port: PORT });
eq(started.port, PORT, '1. 引擎在隔离端口启动');

try {
  // 发一条会失败的请求（没有真实上游 key）—— 失败也要记账
  const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 5 }),
  });
  await res.text();

  // 推送是同步发生在 recordUsage 里的，给一点时间落定
  await new Promise((r) => setTimeout(r, 300));

  ok(pushed.length >= 1, `2. 请求之后推送被触发（收到 ${pushed.length} 条）`);
  if (pushed.length) {
    const e = pushed[0];
    ok(e.ts > 0, '3. 推送的记录带时间戳');
    eq(e.model, 'cline-pass/deepseek-v4.1-flash', '4. 推送的模型名正确');
    eq(e.source, 'proxy', '5. 来源标记为 proxy');
    ok('costCny' in e, '6. 推送里带了人民币字段（哪怕是 null）');
    // 这条请求没有 token（被上游拒绝），人民币应为 0 而不是 null ——
    // 模型能认出来，只是没消耗 token
    eq(e.costCny, 0, '7. 无 token 的失败请求人民币记 0');
  }

  // 去重的记录不应重复推送
  const before = pushed.length;
  await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cline-pass/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'again' }], max_tokens: 5 }),
  }).then((r) => r.text());
  await new Promise((r) => setTimeout(r, 300));
  eq(pushed.length, before + 1, '8. 第二次请求再推一条（每条新记录推一次）');

  // 注册成 null 之后不再推送（命令行独立运行时的情形）
  mod.setUsageSink(null);
  const after = pushed.length;
  await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'k3', messages: [{ role: 'user', content: 'x' }], max_tokens: 5 }),
  }).then((r) => r.text());
  await new Promise((r) => setTimeout(r, 300));
  eq(pushed.length, after, '9. 注销后不再推送（且不报错）');

  // 注销之后记录仍然照常落库 —— 推送失败/没人接收绝不能影响记账
  const rec = await fetch(`http://127.0.0.1:${PORT}/api/usage/records?limit=10`).then((r) => r.json());
  ok(rec.detailLines >= 3, `10. 注销推送后记录仍然落库（${rec.detailLines} 条）`);
  ok(rec.records.length >= 3, '11. 明细接口能读到这些记录');
  ok(rec.records.every((r, i) => i === 0 || r.ts <= rec.records[i - 1].ts), '12. 明细严格时间倒序');
} finally {
  await mod.stop();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
}

console.log(`\n用量实时推送：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
