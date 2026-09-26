// anthropic.js 的离线测试：请求翻译、响应翻译、流式 SSE 状态机
// 用法: node scripts/test-anthropic.mjs
import {
  toChatRequest,
  toAnthropicResponse,
  createSseTranslator,
  estimateInputTokens,
  anthropicUsage,
} from '../src/main/engine/anthropic.js';

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fails.push(label + (detail ? ' → ' + detail : ''));
    console.log('  ✗ ' + label + (detail ? ' → ' + detail : ''));
  }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

// ============ 1. 请求：一份贴近 Claude Code 实际形状的请求 ============
console.log('\n— 请求翻译（Anthropic → Chat）—');
const anthReq = {
  model: 'cline-pass/deepseek-v4.1-flash',
  max_tokens: 8192,
  temperature: 1,
  system: [
    { type: 'text', text: 'You are Claude Code.' },
    { type: 'text', text: 'Be concise.' },
  ],
  stop_sequences: ['\n\nHuman:'],
  tools: [
    {
      name: 'Read',
      description: 'Read a file',
      input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  ],
  tool_choice: { type: 'auto' },
  messages: [
    { role: 'user', content: [{ type: 'text', text: '看看这个文件' }] },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: '我来读一下。' },
        { type: 'tool_use', id: 'toolu_01', name: 'Read', input: { path: '/etc/hosts' } },
      ],
    },
    {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: [{ type: 'text', text: '127.0.0.1 localhost' }] },
        { type: 'text', text: '继续' },
      ],
    },
  ],
};
const chat = toChatRequest(anthReq);

eq(chat.messages[0], { role: 'system', content: 'You are Claude Code.\n\nBe concise.' }, 'system 数组合并成一条 system 消息');
eq(chat.messages[1], { role: 'user', content: '看看这个文件' }, '纯文本 user 轮次退化成字符串');
eq(
  chat.messages[2],
  { role: 'assistant', content: '我来读一下。', tool_calls: [{ id: 'toolu_01', type: 'function', function: { name: 'Read', arguments: '{"path":"/etc/hosts"}' } }] },
  'assistant 的 text + tool_use 合并成 content + tool_calls',
);
eq(chat.messages[3], { role: 'tool', tool_call_id: 'toolu_01', content: '127.0.0.1 localhost' }, 'tool_result 变独立 tool 消息');
eq(chat.messages[4], { role: 'user', content: '继续' }, 'tool_result 同轮的其他内容另起 user 消息');
ok(chat.messages.length === 5, '总消息数为 5', String(chat.messages.length));
ok(chat.messages[3].role === 'tool' && chat.messages[2].tool_calls, 'tool 消息紧跟带 tool_calls 的 assistant（OpenAI 硬要求）');
eq(chat.model, 'cline-pass/deepseek-v4.1-flash', 'model 必须带上（漏了上游会报 missing model field）');
eq(chat.stream, undefined, '未要求流式时不写 stream');
eq(chat.max_tokens, 8192, 'max_tokens 透传');
eq(chat.temperature, 1, 'temperature 透传');
eq(chat.stop, ['\n\nHuman:'], 'stop_sequences → stop');
eq(chat.tools[0].function.name, 'Read', 'tools 转 function');
eq(chat.tools[0].function.parameters, { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, 'input_schema → parameters');
eq(chat.tool_choice, 'auto', 'tool_choice auto');
ok(!('anthropic_version' in chat) && !('metadata' in chat), 'Anthropic 专有字段没有被带上');

// tool_choice 的其它取值
eq(toChatRequest({ messages: [], tools: [{ name: 'T' }], tool_choice: { type: 'any' } }).tool_choice, 'required', 'tool_choice any → required');
eq(
  toChatRequest({ messages: [], tools: [{ name: 'T' }], tool_choice: { type: 'tool', name: 'T' } }).tool_choice,
  { type: 'function', function: { name: 'T' } },
  'tool_choice tool → function',
);
eq(toChatRequest({ messages: [], tool_choice: { type: 'any' } }).tool_choice, undefined, '没有 tools 时不写 tool_choice');

// 图片
const imgChat = toChatRequest({
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
      ],
    },
  ],
});
ok(Array.isArray(imgChat.messages[0].content) && imgChat.messages[0].content[1].image_url.url === 'data:image/png;base64,AAAA', 'base64 图片 → image_url');
ok(toChatRequest({ messages: [], stream: true }).stream === true, 'stream 透传');

// 错误状态的 tool_result 加前缀
const errTool = toChatRequest({
  messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'boom', is_error: true }] }],
});
eq(errTool.messages[0].content, 'Error: boom', 'is_error 的 tool_result 加 Error 前缀');

// ============ 2. 响应：非流式 ============
console.log('\n— 响应翻译（Chat → Anthropic）—');
const anthResp = toAnthropicResponse(
  {
    id: 'chatcmpl-1',
    model: 'cline-pass/glm-5.3-flash',
    choices: [{ message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3 },
  },
  { model: 'cline-pass/deepseek-v4.1-flash' },
);
ok(/^msg_/.test(anthResp.id), 'id 前缀是 msg_');
eq(anthResp.type, 'message', 'type = message');
eq(anthResp.role, 'assistant', 'role = assistant');
eq(anthResp.model, 'cline-pass/deepseek-v4.1-flash', 'model 用请求里的（客户端认这个）');
eq(anthResp.content, [{ type: 'text', text: '你好' }], 'content 是 text 块数组');
eq(anthResp.stop_reason, 'end_turn', 'finish_reason stop → end_turn');
eq(anthResp.usage, { input_tokens: 12, output_tokens: 3 }, 'usage 字段名换成 Anthropic 的');

const toolResp = toAnthropicResponse({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'Read', arguments: '{"path":"/a"}' } }],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: {},
});
eq(toolResp.content, [{ type: 'tool_use', id: 'call_9', name: 'Read', input: { path: '/a' } }], 'tool_calls → tool_use 块（input 解成对象）');
eq(toolResp.stop_reason, 'tool_use', 'finish_reason tool_calls → tool_use');

eq(toAnthropicResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'length' }] }).stop_reason, 'max_tokens', 'length → max_tokens');
const emptyResp = toAnthropicResponse({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
ok(emptyResp.content.length === 1 && emptyResp.content[0].type === 'text', '空回复补一个空 text 块（content 不能是空数组）');
// 参数不是合法 JSON 时兜底
const badArgs = toAnthropicResponse({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'T', arguments: '{"a":' } }] }, finish_reason: 'tool_calls' }] });
ok(badArgs.content[0].input.__raw === '{"a":', '工具参数非法 JSON 时兜底成 __raw');

// ============ 3. 流式：Chat SSE → Anthropic SSE ============
console.log('\n— 流式翻译（Chat SSE → Anthropic SSE）—');

// 解析 Anthropic SSE 文本成 [{event, data}]，并断言语法完好
function parseSse(text) {
  const out = [];
  for (const raw of text.split('\n\n')) {
    const block = raw.trim();
    if (!block) continue;
    const ev = /^event:\s*(.+)$/m.exec(block);
    const da = /^data:\s*(.+)$/m.exec(block);
    if (!ev || !da) throw new Error('SSE 块缺 event 或 data: ' + JSON.stringify(block.slice(0, 120)));
    out.push({ event: ev[1].trim(), data: JSON.parse(da[1]) });
  }
  return out;
}

function runStream(chatChunks, { model = 'm' } = {}) {
  const tr = createSseTranslator({ model });
  let out = '';
  for (const c of chatChunks) out += tr.push(c);
  out += tr.end();
  return { text: out, events: parseSse(out), tr };
}

// 一个「文本 + 工具调用」的完整上游流；刻意在 JSON 中间切断，验证跨 chunk 缓冲
const upstream = [
  'data: {"id":"c1","choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"content":"我来"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"content":"读一下"},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/etc/hosts\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"id":"c1","choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":7}}\n\n',
  'data: [DONE]\n\n',
].join('');

// 按各种别扭的边界切块：把整串按 37 字节切，再把其中一段切成单字符
const chunks = [];
for (let i = 0; i < upstream.length; i += 37) chunks.push(upstream.slice(i, i + 37));
const splitRun = runStream(chunks);
ok(splitRun.events.length > 0, '任意切块也能产出合法 SSE（跨 chunk 缓冲生效）', splitRun.events.length + ' 个事件');

const ev = splitRun.events;
eq(ev[0].event, 'message_start', '首事件是 message_start');
eq(ev[0].data.message.role, 'assistant', 'message_start 的 role');
eq(ev[0].data.message.model, 'm', 'message_start 带 model');
eq(ev[0].data.message.content, [], 'message_start 的 content 为空数组');
ok(ev[0].data.message.usage.input_tokens === 0, 'message_start 有 usage.input_tokens');

const starts = ev.filter((e) => e.event === 'content_block_start');
eq(starts.length, 2, '开了两个内容块（文本 + 工具）');
eq(starts[0].data.content_block.type, 'text', '第 0 块是 text');
eq(starts[0].data.index, 0, '第 0 块 index=0');
eq(starts[1].data.content_block.type, 'tool_use', '第 1 块是 tool_use');
eq(starts[1].data.index, 1, '第 1 块 index=1');
eq(starts[1].data.content_block.name, 'Read', 'tool_use 带 name');
eq(starts[1].data.content_block.id, 'call_a', 'tool_use 带 id');

const textDeltas = ev.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta');
eq(textDeltas.map((e) => e.data.delta.text).join(''), '我来读一下', '文本增量拼回原文');
ok(textDeltas.every((e) => e.data.index === 0), '文本增量都在 index 0');

const jsonDeltas = ev.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta');
ok(jsonDeltas.length === 2, '工具参数分两片下发', String(jsonDeltas.length));
const rebuilt = jsonDeltas.map((e) => e.data.delta.partial_json).join('');
eq(JSON.parse(rebuilt), { path: '/etc/hosts' }, '参数分片拼回合法 JSON');
ok(jsonDeltas.every((e) => e.data.index === 1), '参数增量都在 index 1');

const stops = ev.filter((e) => e.event === 'content_block_stop');
eq(stops.map((e) => e.data.index), [0, 1], '两个块按顺序关闭');

const last = ev[ev.length - 1];
eq(last.event, 'message_stop', '末事件是 message_stop');
const md = ev.find((e) => e.event === 'message_delta');
eq(md.data.delta.stop_reason, 'tool_use', 'message_delta 的 stop_reason = tool_use');
eq(md.data.usage.output_tokens, 7, 'message_delta 带 output_tokens');

// 事件顺序：块必须在 message_start 之后、message_delta 之前
const names = ev.map((e) => e.event);
ok(names.indexOf('message_start') < names.indexOf('content_block_start'), 'message_start 在 content_block_start 之前');
ok(names.lastIndexOf('content_block_stop') < names.indexOf('message_delta'), '所有块关闭后才发 message_delta');
ok(names.filter((n) => n === 'message_start').length === 1 && names.filter((n) => n === 'message_stop').length === 1, 'message_start / message_stop 各只出现一次');

// 纯文本流
const plain = runStream([
  'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
]);
const pev = plain.events.map((e) => e.event);
eq(pev, ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop'], '纯文本流事件序列');
eq(plain.events.find((e) => e.event === 'message_delta').data.delta.stop_reason, 'end_turn', '纯文本流 stop_reason = end_turn');

// 空流：也应给出合法的收尾（不能漏 message_stop，否则客户端会挂住）
const empty = runStream(['data: [DONE]\n\n']);
ok(empty.events.some((e) => e.event === 'message_stop'), '空流也补上 message_stop');

// 上游报错混在 SSE 里：不能把 {"error":...} 当正常 chunk
const errStream = runStream(['data: {"error":{"message":"boom"}}\n\n', 'data: [DONE]\n\n']);
ok(errStream.events.some((e) => e.event === 'message_stop'), '错误 chunk 不炸，仍能收尾');

// 重复调用 end() 不应重复输出
const tr2 = createSseTranslator({});
tr2.push('data: {"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}\n\n');
const e1 = tr2.end();
const e2 = tr2.end();
ok(e1.length > 0 && e2 === '', 'end() 幂等');

// 上游带 event: 行与注释也不能干扰
const noisy = runStream([': ping\n\nevent: message\ndata: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n']);
eq(noisy.events.find((e) => e.event === 'content_block_delta').data.delta.text, 'ok', '忽略上游 event:/注释行');

// ============ 4. count_tokens 估算 ============
console.log('\n— count_tokens 估算 —');
const t1 = estimateInputTokens({ messages: [{ role: 'user', content: 'hello world' }] });
ok(t1 > 0 && t1 < 50, '英文短句估算合理', String(t1));
const t2 = estimateInputTokens({ messages: [{ role: 'user', content: '你好，世界' }] });
ok(t2 > 0, '中文估算合理', String(t2));
const t3 = estimateInputTokens(anthReq);
ok(t3 > t1, '带工具和历史的请求估算更大', t3 + ' vs ' + t1);
ok(estimateInputTokens({ messages: [] }) >= 1, '空请求也给至少 1');

// ============ 5. usage 口径（缓存不能虚高 input）============
console.log('\n— usage 口径 —');
{
  // 上游 OpenAI 口径：prompt_tokens 含缓存命中。实测有单次 53 万缓存命中的请求，
  // 不扣掉的话 Claude Code 的上下文读数会离谱地虚高。
  const u = anthropicUsage({
    prompt_tokens: 1000, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
  });
  eq(u.input_tokens, 200, 'input_tokens 扣掉缓存命中部分');
  eq(u.output_tokens, 200, 'output_tokens 取 completion_tokens');
  eq(u.cache_read_input_tokens, 800, '缓存命中单列为 cache_read_input_tokens');

  // 没有缓存时不该出现缓存字段（避免客户端把 0 当真实读数）
  const u2 = anthropicUsage({ prompt_tokens: 500, completion_tokens: 50 });
  eq(u2.input_tokens, 500, '无缓存时 input = prompt');
  eq(u2.cache_read_input_tokens, undefined, '无缓存时不带 cache_read 字段');
  eq(u2.cache_creation_input_tokens, undefined, '无缓存时不带 cache_creation 字段');

  // 缓存创建也要扣
  const u3 = anthropicUsage({
    prompt_tokens: 1000, completion_tokens: 1, cache_creation_input_tokens: 300,
  });
  eq(u3.input_tokens, 700, 'input 同时扣掉缓存创建');
  eq(u3.cache_creation_input_tokens, 300, '缓存创建单列');

  // 脏数据：缓存比 prompt 还大时不能出负数
  const u4 = anthropicUsage({ prompt_tokens: 100, cached_tokens: 999, prompt_tokens_details: { cached_tokens: 999 } });
  eq(u4.input_tokens, 0, '缓存大于 prompt 时 input 归 0 而非负数');

  // 空/缺失不该炸
  eq(anthropicUsage(null).input_tokens, 0, 'null usage 归 0');
  eq(anthropicUsage(undefined).output_tokens, 0, 'undefined usage 归 0');

  // 响应翻译要走同一套口径
  const r = toAnthropicResponse({
    choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1000, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 900 } },
  });
  eq(r.usage.input_tokens, 100, 'toAnthropicResponse 的 input 也扣缓存');
  eq(r.usage.cache_read_input_tokens, 900, 'toAnthropicResponse 带出缓存命中');
}

// 流式：上游最后一片带 usage（实测有此字段），要完整回传给客户端
{
  const s = runStream([
    'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":700},"cost":0.0021}}\n\n',
    'data: [DONE]\n\n',
  ]);
  const u = s.tr.usage;
  eq(u.input_tokens, 300, '流式 usage 的 input 扣掉缓存');
  eq(u.output_tokens, 30, '流式 usage 带出 output');
  eq(u.cache_read_input_tokens, 700, '流式 usage 带出缓存命中');
  eq(u.prompt_tokens, 1000, '流式 usage 保留上游原始 prompt 口径');
  ok(Math.abs(u.realCost - 0.0021) < 1e-9, '流式 usage 带出上游真实成本', String(u.realCost));
  // 客户端拿到的 message_delta 里也要有缓存读数
  const delta = s.events.filter((e) => e.event === 'message_delta').pop();
  eq(delta.data.usage.input_tokens, 300, 'message_delta 里的 input 已扣缓存');
  eq(delta.data.usage.cache_read_input_tokens, 700, 'message_delta 里带出缓存命中');
}

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过（共 ' + (pass + fails.length) + '）' : '✓ 全部通过（共 ' + pass + ' 项）'));
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
