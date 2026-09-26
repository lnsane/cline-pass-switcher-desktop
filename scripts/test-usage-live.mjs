// 用量统计的活体测试：起一个隔离的引擎实例，打真实上游，
// 验证 token / 缓存 / 成本真的被记下来，以及去重、汇总、会话扫描都工作。
// 全程用独立 DATA_DIR 与独立端口，不碰用户正在跑的 3199。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.ENGINE_TEST_PORT) || 3497;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-live-'));
const PROJECTS = path.join(DATA, 'projects');
fs.mkdirSync(PROJECTS, { recursive: true });

// 隔离的数据目录：拷一份真实配置（含账号密钥），改端口与密钥
const REAL = path.join(process.env.APPDATA, 'Cline Pass Switcher');
const cfg = JSON.parse(fs.readFileSync(path.join(REAL, 'config.json'), 'utf8'));
cfg.port = PORT;
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify(cfg, null, 2));

process.env.DATA_DIR = DATA;
process.env.CLAUDE_PROJECTS_DIR = PROJECTS;

let pass = 0; let fail = 0; const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); return; }
  fail++; fails.push(label + (detail ? ' → ' + detail : ''));
  console.log('  ✗ ' + label + (detail ? ' → ' + detail : ''));
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);

const eng = await import('../src/main/engine/engine.js');
const { port } = await eng.start();
const BASE = `http://127.0.0.1:${port}`;
console.log(`引擎已启动于 ${port}，数据目录 ${DATA}\n`);

const MODEL = 'cline-pass/deepseek-v4.1-flash';
const get = async (p) => (await fetch(BASE + p)).json();
const post = async (p, body) => (await fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
})).json();

// ---------- 1) 非流式请求要记下 token 与成本 ----------
console.log('— 非流式请求 —');
{
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 10 separated by spaces.' }], max_tokens: 200 }),
  });
  eq(res.status, 200, '非流式请求成功');
  const j = await res.json();
  ok(j.usage && j.usage.prompt_tokens > 0, '上游返回了 usage', JSON.stringify(j.usage).slice(0, 120));

  await new Promise((r) => setTimeout(r, 300));
  const u = await get('/api/usage?days=7');
  ok(u.totals.requests >= 1, '用量里记下了这次请求', 'requests=' + u.totals.requests);
  ok(u.totals.input > 0, 'input token 已记录', String(u.totals.input));
  ok(u.totals.output > 0, 'output token 已记录', String(u.totals.output));
  ok(u.totals.cost > 0, '成本已记录（有上游真实成本就用真实的）', String(u.totals.cost));

  // 真实成本优先：上游网关会给 provider_metadata.gateway.cost
  const recs = await get('/api/usage/records?limit=5');
  const r0 = recs.records[0];
  ok(r0, '明细里有这条记录');
  eq(r0.source, 'proxy', '来源标记为 proxy');
  ok(r0.costSource === 'real' || r0.costSource === 'estimated', '成本来源已标注', r0.costSource);
  ok(r0.id && r0.id.length > 4, '记录带请求 id（用于去重）', r0.id);
  ok(r0.provider, '记录了实际上游渠道', String(r0.provider));
  console.log(`    （本次：in=${r0.input} out=${r0.output} cache=${r0.cacheRead} cost=${r0.cost} 来源=${r0.costSource}）`);
}

// ---------- 2) 流式请求要记下 token（这是最容易漏的一条路径）----------
console.log('\n— 流式请求 —');
{
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Count from 1 to 15 separated by spaces.' }], max_tokens: 200, stream: true }),
  });
  eq(res.status, 200, '流式请求成功');
  const text = await res.text();
  ok(text.includes('data:'), '收到 SSE 数据');

  await new Promise((r) => setTimeout(r, 400));
  const recs = await get('/api/usage/records?limit=5&source=proxy');
  const streamed = recs.records.find((r) => r.stream);
  ok(streamed, '流式请求也被记入用量');
  ok(streamed.output > 0, '流式请求的 output token 已记录（关键：以前这里恒为 0）', String(streamed.output));
  ok(streamed.input > 0 || streamed.cacheRead > 0, '流式请求的 input/cache 已记录', `in=${streamed.input} cache=${streamed.cacheRead}`);
  ok(streamed.cost != null && streamed.cost > 0, '流式请求的成本已记录', String(streamed.cost));
  console.log(`    （流式：in=${streamed.input} out=${streamed.output} cache=${streamed.cacheRead} cost=${streamed.cost}）`);
}

// ---------- 3) Anthropic Messages 路径（Claude Code 直连）----------
console.log('\n— /v1/messages 请求 —');
{
  const res = await fetch(BASE + '/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'local-proxy-no-key', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: 'Count from 1 to 12 separated by spaces.' }] }),
  });
  eq(res.status, 200, 'Messages 请求成功');
  const j = await res.json();
  ok(j.usage && j.usage.input_tokens >= 0, 'Anthropic 响应带 usage', JSON.stringify(j.usage));

  await new Promise((r) => setTimeout(r, 400));
  const recs = await get('/api/usage/records?limit=6');
  const m = recs.records.find((r) => r.stream === false && r.model === MODEL);
  ok(m, 'Messages 请求已记入用量');
}

// ---------- 4) 按天汇总的结构 ----------
console.log('\n— 汇总结构 —');
{
  const u = await get('/api/usage?days=7');
  ok(Array.isArray(u.daily), 'daily 是数组');
  ok(u.daily.length >= 1, '至少有一天的数据');
  const day = u.daily[u.daily.length - 1];
  ok(/^\d{4}-\d{2}-\d{2}$/.test(day.date), '日期格式为 YYYY-MM-DD', day.date);
  ok(Array.isArray(day.rollups) && day.rollups.length >= 1, '当天有分桶');
  const r = day.rollups[0];
  ok('account' in r && 'provider' in r && 'model' in r, '分桶包含账号/渠道/模型维度');
  ok('bySource' in r, '分桶按来源分别计数');
  const t = u.totals;
  ok(t.requests >= 3, '总计累计了至少 3 次请求', String(t.requests));
  ok(t.costReal >= 0 && t.costEstimated >= 0, '真实成本与估算成本分开累计');
  console.log(`    （总计：${t.requests} 次请求，in=${t.input} out=${t.output} cache=${t.cacheRead} 成本=$${t.cost.toFixed(6)}）`);
}

// ---------- 5) 会话记录扫描（不开代理也能统计）----------
console.log('\n— 会话记录扫描 —');
{
  // 造一个假的 Claude Code 会话目录
  const projDir = path.join(PROJECTS, 'C--Users-test-demo');
  fs.mkdirSync(projDir, { recursive: true });
  const rec = (id, i, o, cr) => JSON.stringify({
    type: 'assistant', timestamp: new Date().toISOString(), sessionId: 'sess-x',
    message: { id, model: MODEL, usage: { input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: 0 } },
  });
  fs.writeFileSync(path.join(projDir, 'sess-x.jsonl'), [rec('gen_fake_1', 500, 50, 0), rec('gen_fake_2', 200, 20, 900)].join('\n') + '\n');

  const before = (await get('/api/usage?days=7')).totals.requests;
  const s1 = await post('/api/usage/scan');
  eq(s1.ok, true, '扫描接口成功');
  eq(s1.added, 2, '扫到 2 条会话记录');
  const after1 = (await get('/api/usage?days=7')).totals.requests;
  eq(after1, before + 2, '扫描后总数增加 2');

  // 再扫一次不重复
  const s2 = await post('/api/usage/scan');
  eq(s2.added, 0, '重复扫描不重复计入（增量）');
  const after2 = (await get('/api/usage?days=7')).totals.requests;
  eq(after2, after1, '总数没变');

  // 会话记录的账号/渠道未知，不能编造
  const recs = await get('/api/usage/records?limit=20&source=session');
  ok(recs.records.length >= 2, '会话记录进了明细');
  eq(recs.records[0].account, null, '会话记录不带账号（不编造）');
  eq(recs.records[0].source, 'session', '来源标记为 session');

  // 去重：会话里出现一个已被代理记录过的 id，应被跳过
  const proxyRec = (await get('/api/usage/records?limit=5&source=proxy')).records[0];
  if (proxyRec && proxyRec.id) {
    fs.appendFileSync(path.join(projDir, 'sess-x.jsonl'), rec(proxyRec.id, 9999, 9999, 0) + '\n');
    const s3 = await post('/api/usage/scan');
    eq(s3.added, 0, '已被代理记录的请求在扫描时被跳过（跨源去重）');
  } else {
    ok(false, '没能取到代理记录来做去重验证');
  }
}

// ---------- 6) 定价表 ----------
console.log('\n— 定价 —');
{
  const p = await get('/api/usage/pricing');
  ok(p.ok, '定价接口可用');
  ok(p.pricing['claude-opus-5'], '内置定价表包含 Opus 5');
  ok(Object.keys(p.pricing).length >= 20, '定价表条目充足', String(Object.keys(p.pricing).length));

  // 写一条自定义定价并验证生效
  const w = await post('/api/usage/pricing', { pricing: { '我造的模型': { n: '我造的模型', i: 100, o: 200, cr: 0, cc: 0 } } });
  ok(w.ok, '自定义定价写入成功');
  ok(w.pricing['我造的模型'], '返回的定价表包含新条目');
  eq(w.pricing['我造的模型'].i, 100, '自定义价格生效');
}

// ---------- 7) 统计失败不能影响代理 ----------
console.log('\n— 健壮性 —');
{
  // 塞一行坏数据进明细，代理仍应正常工作。
  // 注意 max_tokens 要用大一点：推理模型在 16 个 token 下会耗尽预算返回
  // 「empty response content」（502）—— 那是上游的既有行为，与本改动无关。
  fs.appendFileSync(path.join(DATA, 'usage', 'usage.jsonl'), '{坏行不是JSON\n');
  const ask = () => fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 200 }),
  });
  const res = await ask();
  eq(res.status, 200, '明细里有坏数据时代理仍正常');

  const recs = await get('/api/usage/records?limit=10');
  ok(recs.ok, '明细接口在坏行存在时仍可用');

  // 裁剪要能剔除坏行
  const c = await post('/api/usage/compact', { keepDays: 3650 });
  ok(c.ok, '裁剪接口可用');
  ok(c.removed >= 1, '坏行被裁掉', 'removed=' + c.removed);
  const res2 = await ask();
  eq(res2.status, 200, '裁剪之后代理仍正常');
}

// ---------- 8) 用户真实 3199 没被动过 ----------
console.log('\n— 隔离性 —');
{
  const net = await import('node:net');
  const listening = await new Promise((resolve) => {
    const s = net.default.connect(3199, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 1500);
  });
  ok(listening, '用户的 3199 仍在监听（没被影响）');
}

await eng.stop();
console.log(`\n用量统计活体测试：${pass} 项通过，${fail} 项失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of fails) console.log('  ✗ ' + f);
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  process.exit(1);
}
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
console.log('全部通过 ✓');
