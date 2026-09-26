// /v1/messages 的真实上游集成测试（打的是真 Cline 上游，用的是一份隔离的配置副本）
// 用法: BASE=http://127.0.0.1:3251 MODEL=cline-pass/deepseek-v4.1-flash node scripts/test-messages-live.mjs
const BASE = process.env.BASE || 'http://127.0.0.1:3251';
const MODEL = process.env.MODEL || 'cline-pass/deepseek-v4.1-flash';
const KEY = process.env.PROXY_KEY || ''; // 设了就拿去当 x-api-key 用

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fails.push(label + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + label + (detail ? ' → ' + detail : '')); }
}

function headers() {
  const h = { 'Content-Type': 'application/json' };
  if (KEY) h['x-api-key'] = KEY;
  return h;
}

async function post(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 流式或非 JSON */ }
  return { status: r.status, ctype: r.headers.get('content-type') || '', text, json };
}

// 把 Anthropic SSE 解成事件数组（顺便验证每一块的语法都完好）
function parseSse(text) {
  const out = [];
  for (const raw of text.split('\n\n')) {
    const block = raw.trim();
    if (!block) continue;
    const ev = /^event:\s*(.+)$/m.exec(block);
    const da = /^data:\s*(.+)$/m.exec(block);
    if (!ev || !da) throw new Error('SSE 块缺 event/data: ' + JSON.stringify(block.slice(0, 160)));
    out.push({ event: ev[1].trim(), data: JSON.parse(da[1]) });
  }
  return out;
}

async function stream(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const ctype = r.headers.get('content-type') || '';
  if (r.status !== 200) return { status: r.status, ctype, events: [], text: await r.text() };
  // 逐块读，模拟真实客户端；顺便确认服务端是边算边发，而不是攒完一次性给
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  let chunks = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks++;
    text += dec.decode(value, { stream: true });
  }
  return { status: r.status, ctype, events: parseSse(text), text, chunks };
}

const userMsg = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] });
// 不做 Anthropic 解析的裸流读取（给 OpenAI SSE 回归测试用）
async function rawStream(path, body) {
  const r = await fetch(BASE + path, { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, ctype: r.headers.get('content-type') || '', text };
}
// 断言失败时响应体可能是错误对象，取值一律走这两个兜底函数，免得测试自己崩掉
const blocks = (m) => (m && Array.isArray(m.content) ? m.content : []);
const bodyText = (m) => blocks(m).filter((c) => c.type === 'text').map((c) => c.text).join('');

// ============================================================
console.log('\n=== 0. 连通性 ===');
const meta = await fetch(BASE + '/api/meta').then((r) => r.json()).catch((e) => ({ error: e.message }));
ok(meta && meta.proxyBase, '代理在 ' + BASE + ' 上活着', JSON.stringify(meta).slice(0, 120));
ok(meta.configured !== false, '账号已配置');

console.log('\n=== 1. 非流式 /v1/messages ===');
{
  const r = await post('/v1/messages', { model: MODEL, max_tokens: 64, messages: [userMsg('回答两个字：收到')] });
  ok(r.status === 200, 'HTTP 200', String(r.status) + ' ' + r.text.slice(0, 200));
  ok(r.ctype.includes('application/json'), 'Content-Type 是 application/json', r.ctype);
  const m = r.json;
  ok(m && m.type === 'message', 'type = message', m && m.type);
  ok(m && m.role === 'assistant', 'role = assistant');
  ok(m && /^msg_/.test(m.id || ''), 'id 以 msg_ 开头', m && m.id);
  ok(m && m.model === MODEL, 'model 回显请求里的模型', m && m.model);
  ok(m && Array.isArray(m.content) && m.content.length > 0, 'content 是非空数组');
  ok(bodyText(m).length > 0, '有非空 text 块', JSON.stringify(m && m.content).slice(0, 160));
  ok(m && ['end_turn', 'max_tokens', 'stop_sequence'].includes(m.stop_reason), 'stop_reason 合法', m && m.stop_reason);
  ok(m && m.usage && typeof m.usage.input_tokens === 'number' && typeof m.usage.output_tokens === 'number', 'usage 有 input_tokens/output_tokens', JSON.stringify(m && m.usage));
  ok(m && m.usage.input_tokens > 0, 'input_tokens 是真数（上游回的）', String(m && m.usage.input_tokens));
  console.log('    回复: ' + JSON.stringify(bodyText(m)).slice(0, 120));
}

console.log('\n=== 2. 流式 /v1/messages ===');
{
  const r = await stream('/v1/messages', { model: MODEL, max_tokens: 96, stream: true, messages: [userMsg('从 1 数到 5，用逗号分隔')] });
  ok(r.status === 200, 'HTTP 200', String(r.status) + ' ' + String(r.text).slice(0, 200));
  ok(r.ctype.includes('text/event-stream'), 'Content-Type 是 text/event-stream', r.ctype);
  const names = r.events.map((e) => e.event);
  ok(r.events.length > 0, '收到事件', String(r.events.length));
  ok(names[0] === 'message_start', '首事件 message_start', names[0]);
  ok(names[names.length - 1] === 'message_stop', '末事件 message_stop', names[names.length - 1]);
  ok(names.filter((n) => n === 'message_start').length === 1, 'message_start 只一次');
  ok(names.filter((n) => n === 'message_stop').length === 1, 'message_stop 只一次');
  ok(names.includes('content_block_start'), '有 content_block_start');
  ok(names.includes('content_block_delta'), '有 content_block_delta');
  ok(names.includes('content_block_stop'), '有 content_block_stop');
  ok(names.includes('message_delta'), '有 message_delta');
  ok(names.indexOf('message_start') === 0 && names.indexOf('message_delta') > names.lastIndexOf('content_block_stop'), 'message_delta 在所有块关闭之后');
  const txt = r.events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join('');
  ok(txt.length > 0, '文本增量非空', JSON.stringify(txt.slice(0, 80)));
  console.log('    流式回复: ' + JSON.stringify(txt.slice(0, 120)));
  const md = r.events.find((e) => e.event === 'message_delta');
  ok(md && md.data.usage && typeof md.data.usage.output_tokens === 'number', 'message_delta 带 usage.output_tokens', JSON.stringify(md && md.data.usage));
  ok(r.chunks >= 2, '服务端是分多次发出来的（真流式）', r.chunks + ' 个 chunk');
}

console.log('\n=== 3. 非流式 + 工具调用 ===');
{
  const tools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const r = await post('/v1/messages', {
    model: MODEL, max_tokens: 256, tools, tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [userMsg('北京天气怎么样？用工具查')],
  });
  ok(r.status === 200, 'HTTP 200', String(r.status) + ' ' + r.text.slice(0, 200));
  const m = r.json;
  const tu = blocks(m).find((c) => c.type === 'tool_use');
  ok(!!tu, 'content 里有 tool_use 块', JSON.stringify(m && m.content).slice(0, 200));
  ok(tu && tu.name === 'get_weather', 'tool_use.name 正确', tu && tu.name);
  ok(tu && typeof tu.input === 'object' && !tu.input.__raw, 'tool_use.input 是解析好的对象', JSON.stringify(tu && tu.input));
  ok(m && m.stop_reason === 'tool_use', 'stop_reason = tool_use', m && m.stop_reason);
}

console.log('\n=== 4. 流式 + 工具调用 ===');
{
  const tools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const r = await stream('/v1/messages', {
    model: MODEL, max_tokens: 256, stream: true, tools, tool_choice: { type: 'tool', name: 'get_weather' },
    messages: [userMsg('上海天气怎么样？用工具查')],
  });
  ok(r.status === 200, 'HTTP 200', String(r.status));
  const starts = r.events.filter((e) => e.event === 'content_block_start');
  const tuStart = starts.find((e) => e.data.content_block.type === 'tool_use');
  ok(!!tuStart, '有 tool_use 的 content_block_start', JSON.stringify(starts.map((s) => s.data.content_block.type)));
  ok(tuStart && tuStart.data.content_block.name === 'get_weather', 'tool_use 块带正确 name', tuStart && tuStart.data.content_block.name);
  ok(tuStart && typeof tuStart.data.content_block.input === 'object', 'tool_use 块带空 input 对象');
  const deltas = r.events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
  ok(deltas.length > 0, '有 input_json_delta 分片', String(deltas.length));
  const rebuilt = deltas.map((e) => e.data.delta.partial_json).join('');
  let parsed = null;
  try { parsed = JSON.parse(rebuilt); } catch { /* 留 null */ }
  ok(parsed && typeof parsed === 'object', '参数分片拼回合法 JSON', JSON.stringify(rebuilt).slice(0, 160));
  ok(parsed && typeof parsed.city === 'string' && parsed.city.length > 0, '拼回的参数里有 city', JSON.stringify(parsed));
  ok(deltas.every((e) => e.data.index === tuStart.data.index), '参数分片都落在同一个块下标上');
  ok(r.events.find((e) => e.event === 'message_delta').data.delta.stop_reason === 'tool_use', 'stop_reason = tool_use');
  console.log('    工具参数: ' + JSON.stringify(parsed));
}

console.log('\n=== 5. 工具结果回灌（多轮，验证消息顺序合法）===');
{
  // 这一条最关键：Anthropic 把 tool_result 放在 user 轮次里，翻译时必须拆成独立的 tool 消息，
  // 否则上游会 400「tool 消息没有对应的 tool_call」。用真实上游验证。
  const r = await post('/v1/messages', {
    model: MODEL, max_tokens: 128,
    tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    messages: [
      userMsg('北京天气怎么样？'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_test_1', name: 'get_weather', input: { city: '北京' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_test_1', content: [{ type: 'text', text: '晴，25 度' }] }] },
    ],
  });
  ok(r.status === 200, '多轮 tool_result 请求被上游接受（HTTP 200）', String(r.status) + ' ' + r.text.slice(0, 250));
  const m = r.json;
  ok(m && m.type === 'message' && Array.isArray(m.content), '返回 Anthropic 形状的 message');
  const t = bodyText(m);
  ok(!!t, '模型基于工具结果给出了文字回复', JSON.stringify(String(t || '').slice(0, 120)));
  console.log('    回复: ' + JSON.stringify(String(t || '').slice(0, 120)));
}

console.log('\n=== 6. count_tokens ===');
{
  const r = await post('/v1/messages/count_tokens', { model: MODEL, messages: [userMsg('你好，这是一段用来估算 token 的中文文本')] });
  ok(r.status === 200, 'HTTP 200', String(r.status));
  ok(r.json && typeof r.json.input_tokens === 'number' && r.json.input_tokens > 0, 'input_tokens 是正整数', JSON.stringify(r.json));
}

console.log('\n=== 7. 回归：原有 /v1/chat/completions 没被改坏 ===');
{
  const r = await post('/v1/chat/completions', { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: '回答两个字：收到' }] });
  ok(r.status === 200, 'HTTP 200', String(r.status) + ' ' + r.text.slice(0, 200));
  const j = r.json;
  ok(j && Array.isArray(j.choices) && j.choices.length > 0, '仍是 OpenAI 形状（有 choices）', JSON.stringify(j).slice(0, 160));
  ok(j && j.choices[0].message && typeof j.choices[0].message.content === 'string', 'choices[0].message.content 是字符串');
  ok(j && j.usage && typeof j.usage.prompt_tokens === 'number', 'usage 仍是 prompt_tokens/completion_tokens');
  ok(!j.type || j.type !== 'message', '没有被误转成 Anthropic 形状');
}

console.log('\n=== 8. 回归：流式 /v1/chat/completions 仍是 OpenAI SSE ===');
{
  const r = await rawStream('/v1/chat/completions', { model: MODEL, max_tokens: 64, stream: true, messages: [{ role: 'user', content: '从 1 数到 3' }] });
  ok(r.status === 200, 'HTTP 200', String(r.status));
  ok(/^data: /.test(r.text.trim()), '输出仍是 data: 开头的 OpenAI SSE（没被翻译成 Anthropic 事件）', JSON.stringify(String(r.text).slice(0, 80)));
  ok(!r.text.includes('event: message_start'), '没有混进 Anthropic 事件');
  ok(r.text.includes('[DONE]'), '保留了 [DONE] 结束标记');
}

console.log('\n=== 9. 错误处理 ===');
{
  const r1 = await post('/v1/messages', { messages: [userMsg('hi')] });
  ok(r1.status === 400, '缺 model → 400', String(r1.status));
  ok(r1.json && r1.json.type === 'error' && r1.json.error && r1.json.error.type, '错误是 Anthropic 的 {type:error,error:{type,message}} 形状', JSON.stringify(r1.json).slice(0, 160));
  const r2 = await post('/v1/messages', { model: MODEL, messages: [] });
  ok(r2.status === 400, 'messages 为空 → 400', String(r2.status));
  const r3 = await post('/v1/messages', { model: MODEL, max_tokens: 64, messages: [userMsg('你好')], stream: false });
  ok(r3.status === 200, '显式 stream:false 也能走非流式', String(r3.status));
}

console.log('\n=== 10. 路径写法兼容（不花上游额度，走 count_tokens）===');
{
  // 客户端会往 ANTHROPIC_BASE_URL 后面拼 /v1/messages，而 base 填成 .../v1 时会拼出 /v1/v1/messages。
  // 与其让用户猜该不该带 /v1，不如两种都认。
  for (const p of ['/messages/count_tokens', '/v1/messages/count_tokens', '/api/v1/messages/count_tokens', '/v1/v1/messages/count_tokens']) {
    const r = await post(p, { model: MODEL, messages: [userMsg('hi')] });
    ok(r.status === 200 && r.json && typeof r.json.input_tokens === 'number', '路径 ' + p + ' 可用', String(r.status));
  }
  // 真正的 messages 路径各打一次（这三个才需要上游）
  for (const p of ['/messages', '/api/v1/messages']) {
    const r = await post(p, { model: MODEL, max_tokens: 64, messages: [userMsg('回答两个字：收到')] });
    ok(r.status === 200 && r.json && r.json.type === 'message', '路径 ' + p + ' 可用', String(r.status) + ' ' + r.text.slice(0, 120));
  }
}

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过（共 ' + (pass + fails.length) + '）' : '✓ 全部通过（共 ' + pass + ' 项）'));
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
