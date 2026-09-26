// Anthropic Messages ↔ OpenAI Chat Completions 双向翻译
//
// 为什么需要它：Claude Code 只会说 Anthropic Messages（POST /v1/messages），而 Cline 上游
// 只会说 OpenAI Chat Completions。这一层把请求、响应、以及流式 SSE 双向翻译掉，
// 客户端就能直连本机代理，不必再依赖第三方（cc-switch 等）做转换。
//
// 这个模块是纯函数 + 纯状态机：不碰网络、不碰配置、不碰上游选择。
// 上游钉住 / 故障转移 / 学习 / 记录仍在 engine.js 的既有链路里，本模块只负责协议形状。

const STOP_REASON = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'end_turn',
};

let SEQ = 0;
function newId(prefix) {
  SEQ = (SEQ + 1) % 1e9;
  return prefix + '_' + Date.now().toString(36) + SEQ.toString(36) + Math.random().toString(36).slice(2, 8);
}

// Anthropic 的 system 可以是字符串，也可以是 [{type:'text',text}] 数组
function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (!Array.isArray(system)) return '';
  return system
    .map((b) => (typeof b === 'string' ? b : b && b.type === 'text' ? b.text || '' : ''))
    .filter(Boolean)
    .join('\n\n');
}

// tool_result 的 content 可以是字符串，也可以是内容块数组
function toolResultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content
    .map((b) => {
      if (typeof b === 'string') return b;
      if (!b || typeof b !== 'object') return '';
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function chatPartsFromAnthropicBlocks(blocks) {
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text') {
      if (b.text) parts.push({ type: 'text', text: b.text });
    } else if (b.type === 'image') {
      const src = b.source || {};
      if (src.type === 'base64' && src.data) {
        parts.push({ type: 'image_url', image_url: { url: 'data:' + (src.media_type || 'image/png') + ';base64,' + src.data } });
      } else if (src.type === 'url' && src.url) {
        parts.push({ type: 'image_url', image_url: { url: src.url } });
      }
    }
  }
  return parts;
}

// ---------- 请求：Anthropic Messages → Chat Completions ----------
export function toChatRequest(anth) {
  const messages = [];
  const sys = systemToText(anth.system);
  if (sys) messages.push({ role: 'system', content: sys });

  for (const m of anth.messages || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const content = m.content;

    if (typeof content === 'string') {
      messages.push({ role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (role === 'assistant') {
      const texts = [];
      const toolCalls = [];
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') {
          if (b.text) texts.push(b.text);
        } else if (b.type === 'tool_use') {
          toolCalls.push({
            id: b.id || newId('call'),
            type: 'function',
            function: { name: b.name || 'tool', arguments: JSON.stringify(b.input == null ? {} : b.input) },
          });
        }
        // thinking / redacted_thinking 不回传：签名无法复用，上游也不需要
      }
      const msg = { role: 'assistant', content: texts.length ? texts.join('') : null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content || msg.tool_calls) messages.push(msg);
      continue;
    }

    // user 轮次：tool_result 必须单独成条、且紧跟在带 tool_calls 的 assistant 之后，
    // 否则 OpenAI 侧会报「tool 消息没有对应的 tool_call」。因此先发 tool，再发其余内容。
    const toolMsgs = [];
    for (const b of content) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'tool_result') {
        let text = toolResultText(b.content);
        if (b.is_error) text = 'Error: ' + text;
        toolMsgs.push({ role: 'tool', tool_call_id: b.tool_use_id || 'call_0', content: text || '(empty)' });
      }
    }
    const parts = chatPartsFromAnthropicBlocks(content);
    messages.push(...toolMsgs);
    if (parts.length) {
      // 纯文本时退化成字符串形式，对上游更友好（部分网关不接受 content 数组）
      const onlyText = parts.every((p) => p.type === 'text');
      messages.push({ role: 'user', content: onlyText ? parts.map((p) => p.text).join('') : parts });
    }
  }

  const out = { messages };

  // model 必须带上：上游按这个字段选模型（漏了会直接报 missing model field）
  if (anth.model) out.model = anth.model;
  if (anth.max_tokens != null) out.max_tokens = anth.max_tokens;
  if (anth.temperature != null) out.temperature = anth.temperature;
  if (anth.top_p != null) out.top_p = anth.top_p;
  if (Array.isArray(anth.stop_sequences) && anth.stop_sequences.length) out.stop = anth.stop_sequences;

  if (Array.isArray(anth.tools) && anth.tools.length) {
    const tools = anth.tools
      .filter((t) => t && typeof t === 'object' && t.name)
      .map((t) => {
        const fn = { name: t.name };
        if (t.description) fn.description = t.description;
        fn.parameters = t.input_schema && typeof t.input_schema === 'object' ? t.input_schema : { type: 'object', properties: {} };
        return { type: 'function', function: fn };
      });
    if (tools.length) {
      out.tools = tools;
      const tc = anth.tool_choice;
      if (tc && typeof tc === 'object') {
        if (tc.type === 'any') out.tool_choice = 'required';
        else if (tc.type === 'tool' && tc.name) out.tool_choice = { type: 'function', function: { name: tc.name } };
        else if (tc.type === 'none') out.tool_choice = 'none';
        else out.tool_choice = 'auto';
      }
      // disable_parallel_tool_use 在 Chat 侧没有对应字段，忽略
    }
  }

  if (anth.stream) out.stream = true;
  return out;
}

// ---------- 响应（非流式）：Chat Completions → Anthropic Messages ----------
export function toAnthropicResponse(chat, { model } = {}) {
  const choice = (chat && chat.choices && chat.choices[0]) || {};
  const msg = choice.message || {};

  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    text = msg.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('');
  }

  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const tc of msg.tool_calls || []) {
    content.push({
      type: 'tool_use',
      id: (tc && tc.id) || newId('toolu'),
      name: (tc && tc.function && tc.function.name) || 'tool',
      input: parseToolArgs(tc && tc.function && tc.function.arguments),
    });
  }
  // Anthropic 侧 content 不应为空数组，补一个空文本块
  if (!content.length) content.push({ type: 'text', text: '' });

  const usage = (chat && chat.usage) || {};
  const hasTool = content.some((c) => c.type === 'tool_use');
  return {
    id: newId('msg'),
    type: 'message',
    role: 'assistant',
    model: model || (chat && chat.model) || '',
    content,
    stop_reason: STOP_REASON[choice.finish_reason] || (hasTool ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: anthropicUsage(usage),
  };
}

// 上游 Chat 的 usage → Anthropic 的 usage。
// Anthropic 口径里 input_tokens **不含**缓存部分，缓存单列；
// 上游（OpenAI 口径）的 prompt_tokens 是含缓存的，所以要把缓存减出去。
// 不这么做的话 Claude Code 的上下文读数会虚高（缓存命中越多偏得越狠 ——
// 实测有单次缓存命中 53 万 token 的请求）。
export function anthropicUsage(usage) {
  const u = usage || {};
  const prompt = Number(u.prompt_tokens) || 0;
  const cached = Number(u.prompt_tokens_details?.cached_tokens) || 0;
  const creation = Number(u.cache_creation_input_tokens) || 0;
  const input = Math.max(0, prompt - cached - creation);
  const out = {
    input_tokens: input,
    output_tokens: Number(u.completion_tokens) || 0,
  };
  // 只在确实有缓存时才带上这两个字段：Anthropic 客户端对它们的出现很敏感，
  // 一直塞 0 会让「缓存命中率」这类读数失去意义。
  if (cached) out.cache_read_input_tokens = cached;
  if (creation) out.cache_creation_input_tokens = creation;
  return out;
}

function parseToolArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { __raw: String(raw) };
  }
}

// ---------- 流式：Chat SSE → Anthropic SSE ----------
//
// 上游发的是 OpenAI 的 data-only SSE，客户端要的是 Anthropic 的 event+data SSE。
// 事件序列（客户端按此解析）：
//   message_start → content_block_start → content_block_delta* → content_block_stop
//   →（可多个块）→ message_delta → message_stop
export function createSseTranslator({ model } = {}) {
  let started = false;
  let ended = false;
  let nextIndex = 0;
  let open = null; // { index, type } 当前打开的内容块
  let stopReason = null;
  let outputTokens = 0;
  let promptTokens = 0;        // 上游口径的 prompt_tokens（含缓存），用于算 input
  let cacheReadTokens = 0;
  let cacheCreationTokens = 0;
  let realCost = null;         // 上游网关给的真实成本（provider_metadata.gateway.cost）
  const toolBlocks = new Map(); // Chat 的 tool_calls[].index → Anthropic 的 content 块下标
  const msgId = newId('msg');
  let pending = ''; // 跨 chunk 的半行缓冲
  let raw = ''; // 原始 Chat SSE 文本（供上游路由嗅探用）

  const sse = (event, data) => 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';

  function startIfNeeded() {
    if (started) return '';
    started = true;
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: model || '',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  }

  function closeOpen() {
    if (!open) return '';
    const ev = sse('content_block_stop', { type: 'content_block_stop', index: open.index });
    open = null;
    return ev;
  }

  function openBlock(type, extra) {
    const index = nextIndex++;
    open = { index, type };
    return sse('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: Object.assign({ type }, extra || {}),
    });
  }

  function handleDelta(d) {
    let out = '';
    if (!d || typeof d !== 'object') return out;

    // 文本
    const textPiece =
      typeof d.content === 'string'
        ? d.content
        : Array.isArray(d.content)
          ? d.content.map((p) => (typeof p === 'string' ? p : (p && p.text) || '')).join('')
          : '';
    if (textPiece) {
      if (!open || open.type !== 'text') {
        out += closeOpen();
        out += openBlock('text', { text: '' });
      }
      out += sse('content_block_delta', {
        type: 'content_block_delta',
        index: open.index,
        delta: { type: 'text_delta', text: textPiece },
      });
    }

    // 工具调用（可能被切成多个 chunk：先 id/name，后 arguments 分片）
    for (const tc of d.tool_calls || []) {
      if (!tc || typeof tc !== 'object') continue;
      const key = tc.index == null ? 0 : tc.index;
      let idx = toolBlocks.get(key);
      if (idx == null) {
        out += closeOpen();
        idx = nextIndex++;
        open = { index: idx, type: 'tool_use' };
        toolBlocks.set(key, idx);
        out += sse('content_block_start', {
          type: 'content_block_start',
          index: idx,
          content_block: {
            type: 'tool_use',
            id: tc.id || newId('toolu'),
            name: (tc.function && tc.function.name) || 'tool',
            input: {},
          },
        });
      }
      const args = tc.function && tc.function.arguments;
      if (typeof args === 'string' && args.length) {
        out += sse('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'input_json_delta', partial_json: args },
        });
      }
    }
    // reasoning_content / reasoning 不回传：Anthropic 的 thinking 块需要签名，上游没有
    return out;
  }

  return {
    // 喂入一段上游 SSE 文本，返回要写给客户端的 Anthropic SSE 文本
    push(chunkText) {
      if (ended) return '';
      raw += chunkText;
      pending += chunkText;
      let out = '';
      const lines = pending.split('\n');
      pending = lines.pop(); // 最后一段可能不完整，留到下次
      for (const line of lines) {
        const t = line.trim();
        if (!t || t.startsWith(':')) continue;
        if (!t.startsWith('data:')) continue; // 忽略上游的 event:/id: 行
        const payload = t.slice(5).trim();
        if (!payload) continue;
        if (payload === '[DONE]') continue; // 收尾由 end() 统一处理
        let json = null;
        try {
          json = JSON.parse(payload);
        } catch {
          continue;
        }
        out += startIfNeeded();
        if (json.usage && typeof json.usage === 'object') {
          if (json.usage.prompt_tokens) promptTokens = json.usage.prompt_tokens;
          if (json.usage.completion_tokens) outputTokens = json.usage.completion_tokens;
          const cached = json.usage.prompt_tokens_details?.cached_tokens;
          if (cached) cacheReadTokens = Number(cached) || 0;
          const creation = json.usage.cache_creation_input_tokens;
          if (creation) cacheCreationTokens = Number(creation) || 0;
          if (json.usage.cost != null) realCost = Number(json.usage.cost);
          else if (json.usage.gateway_cost != null) realCost = Number(json.usage.gateway_cost);
        }
        const choice = (json.choices && json.choices[0]) || null;
        if (choice) {
          out += handleDelta(choice.delta);
          if (choice.finish_reason) stopReason = STOP_REASON[choice.finish_reason] || null;
        }
      }
      return out;
    },

    // 收尾：关掉未闭合的块，补 message_delta 与 message_stop
    end() {
      if (ended) return '';
      ended = true;
      let out = startIfNeeded();
      out += closeOpen();
      const reason = stopReason || (toolBlocks.size ? 'tool_use' : 'end_turn');
      out += sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: reason, stop_sequence: null },
        // 上游的用量在流的最后一个分片里（带 usage 的那个 chunk），
        // 实测确实有 —— 早先以为网关不返回是看漏了。这里把它完整回传，
        // 缓存命中量大时 input 必须扣掉缓存，否则客户端的上下文读数会虚高。
        usage: anthropicUsage({
          prompt_tokens: promptTokens,
          completion_tokens: outputTokens,
          prompt_tokens_details: { cached_tokens: cacheReadTokens },
          cache_creation_input_tokens: cacheCreationTokens,
        }),
      });
      out += sse('message_stop', { type: 'message_stop' });
      return out;
    },

    get rawText() {
      return raw;
    },
    // 统计用：上游口径的完整用量 + 真实成本。
    // inputTokens 是已扣缓存的 Anthropic 口径，promptTokens 是上游原始口径。
    get usage() {
      return {
        input_tokens: Math.max(0, promptTokens - cacheReadTokens - cacheCreationTokens),
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
        cache_creation_input_tokens: cacheCreationTokens,
        prompt_tokens: promptTokens,
        realCost,
      };
    },
    get stopReason() {
      return stopReason;
    },
  };
}

// ---------- count_tokens 的估算 ----------
// 上游没有暴露分词接口，这里按字符量估：ASCII 约 4 字符/token，CJK 约 1.5 字符/token。
// 只影响客户端的上下文管理阈值，不影响请求本身。
export function estimateInputTokens(anth) {
  let ascii = 0;
  let wide = 0;
  const count = (s) => {
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c < 128) ascii++;
      else wide++;
    }
  };

  count(systemToText(anth.system));
  for (const m of anth.messages || []) {
    if (!m || typeof m !== 'object') continue;
    const c = m.content;
    if (typeof c === 'string') count(c);
    else if (Array.isArray(c)) {
      for (const b of c) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text') count(b.text || '');
        else if (b.type === 'tool_use') {
          count(b.name || '');
          count(JSON.stringify(b.input || {}));
        } else if (b.type === 'tool_result') count(toolResultText(b.content));
        else if (b.type === 'image') count('[image]');
      }
    }
  }
  for (const t of anth.tools || []) {
    if (!t || typeof t !== 'object') continue;
    count(t.name || '');
    count(t.description || '');
    count(JSON.stringify(t.input_schema || {}));
  }
  const tokens = Math.ceil(ascii / 4 + wide / 1.5);
  const overhead = ((anth.messages || []).length + 1) * 4;
  return Math.max(1, tokens + overhead);
}
