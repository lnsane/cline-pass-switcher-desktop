// 鉴权测试：Claude Code 用 x-api-key 带凭据，OpenAI 客户端用 Authorization: Bearer
//
// 设计要点：鉴权测试只验鉴权，不验上游健康度。
// 判定「凭据正确」用 status !== 401（而不是 === 200）——否则上游限流时会把
// 鉴权测试误报成失败。真正需要 200 的断言只放在不触发上游请求的路径上（count_tokens）。
//
// 用法: BASE=http://127.0.0.1:3251 PROXY_KEY=test-proxy-key-abc123 node scripts/test-auth.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:3251';
const KEY = process.env.PROXY_KEY || 'test-proxy-key-abc123';
const MODEL = process.env.MODEL || 'cline-pass/deepseek-v4.1-flash';

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fails.push(label + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + label + (detail ? ' → ' + detail : '')); }
}

async function call(path, headers, body) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

const msgBody = { model: MODEL, max_tokens: 256, messages: [{ role: 'user', content: [{ type: 'text', text: '回答两个字：收到' }] }] };
const chatBody = { model: MODEL, max_tokens: 256, messages: [{ role: 'user', content: '回答两个字：收到' }] };
const countBody = { model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] };

console.log('\n=== /v1/messages 鉴权 ===');
{
  const r1 = await call('/v1/messages', {}, msgBody);
  ok(r1.status === 401, '不带凭据 → 401', String(r1.status));
  ok(r1.json && r1.json.error, '401 也返回 JSON 错误体', r1.text.slice(0, 120));

  const r2 = await call('/v1/messages', { 'x-api-key': KEY }, msgBody);
  ok(r2.status !== 401, 'x-api-key 正确 → 通过鉴权（Claude Code 走这条）', String(r2.status) + ' ' + r2.text.slice(0, 140));
  ok(!(r2.json && r2.json.error && r2.json.error.type === 'auth_error'), 'x-api-key 正确时不是 auth_error');

  const r3 = await call('/v1/messages', { Authorization: 'Bearer ' + KEY }, msgBody);
  ok(r3.status !== 401, 'Authorization: Bearer 正确 → 通过鉴权（原有方式仍可用）', String(r3.status));

  const r4 = await call('/v1/messages', { 'x-api-key': 'wrong-key' }, msgBody);
  ok(r4.status === 401, 'x-api-key 错误 → 401', String(r4.status));

  const r5 = await call('/v1/messages', { 'x-admin-key': KEY }, msgBody);
  ok(r5.status !== 401, 'x-admin-key 正确 → 通过鉴权', String(r5.status));

  const r6 = await call('/v1/messages', { Authorization: 'Bearer wrong-key' }, msgBody);
  ok(r6.status === 401, 'Bearer 错误 → 401', String(r6.status));
}

console.log('\n=== /v1/messages/count_tokens 鉴权（不触发上游，可断言 200）===');
{
  const r1 = await call('/v1/messages/count_tokens', {}, countBody);
  ok(r1.status === 401, '不带凭据 → 401', String(r1.status));
  const r2 = await call('/v1/messages/count_tokens', { 'x-api-key': KEY }, countBody);
  ok(r2.status === 200, 'x-api-key 正确 → 200', String(r2.status));
  ok(r2.json && typeof r2.json.input_tokens === 'number', '返回 input_tokens', JSON.stringify(r2.json));
  const r3 = await call('/v1/messages/count_tokens', { Authorization: 'Bearer ' + KEY }, countBody);
  ok(r3.status === 200, 'Bearer 正确 → 200', String(r3.status));
}

console.log('\n=== 回归：/v1/chat/completions 鉴权没变 ===');
{
  const r1 = await call('/v1/chat/completions', {}, chatBody);
  ok(r1.status === 401, '不带凭据 → 401', String(r1.status));
  const r2 = await call('/v1/chat/completions', { Authorization: 'Bearer ' + KEY }, chatBody);
  ok(r2.status !== 401, 'Bearer 正确 → 通过鉴权', String(r2.status));
  const r3 = await call('/v1/chat/completions', { 'x-api-key': KEY }, chatBody);
  ok(r3.status !== 401, 'x-api-key 也能通过（放宽，不影响鉴权语义）', String(r3.status));
  const r4 = await call('/v1/chat/completions', { Authorization: 'Bearer wrong' }, chatBody);
  ok(r4.status === 401, 'Bearer 错误 → 401', String(r4.status));
}

console.log('\n=== 控制台接口仍然需要鉴权 ===');
{
  const r = await fetch(BASE + '/api/models');
  ok(r.status === 401, '/api/models 不带凭据 → 401', String(r.status));
  const r2 = await fetch(BASE + '/api/meta');
  ok(r2.status === 200, '/api/meta 保持开放（页面要读）', String(r2.status));
  const r3 = await fetch(BASE + '/api/models', { headers: { 'x-api-key': KEY } });
  ok(r3.status === 200, '/api/models 带凭据 → 200', String(r3.status));
}

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过（共 ' + (pass + fails.length) + '）' : '✓ 全部通过（共 ' + pass + ' 项）'));
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}