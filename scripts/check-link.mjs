// 离线校验：把深链接按 cc-switch 的解析规则解回来，逐项核对
// 规则来源 src-tauri/src/deeplink/{parser,provider,utils}.rs：
//   scheme=ccswitch, host=v1, path=/import, resource=provider
//   app ∈ {claude,codex,gemini,grokbuild,opencode,openclaw,hermes}
//   endpoint / apiKey 必填且非空；endpoint 支持逗号分隔；homepage 可省（会从 endpoint 推断）
//   config / usageScript 用 base64 —— 标准与 URL-safe、带填充与不带填充都能解
const link = process.argv[2];
if (!link || !link.startsWith('ccswitch://')) { console.error('用法: node check-link.mjs "ccswitch://..."'); process.exit(1); }

const u = new URL(link);
const fail = [];
const ok = (cond, msg) => { console.log((cond ? '  ✓ ' : '  ✗ ') + msg); if (!cond) fail.push(msg); };

console.log('— 基本结构 —');
ok(u.protocol === 'ccswitch:', 'scheme = ccswitch');
ok(u.host === 'v1', 'host = v1 (版本)');
ok(u.pathname === '/import', 'path = /import');
const q = u.searchParams;
ok(q.get('resource') === 'provider', 'resource = provider');

console.log('— 必填项 —');
const APP = ['claude', 'codex', 'gemini', 'grokbuild', 'opencode', 'openclaw', 'hermes'];
ok(APP.includes(q.get('app')), 'app 合法: ' + q.get('app'));
ok(!!q.get('name'), 'name = ' + q.get('name'));
const endpoint = q.get('endpoint');
ok(!!endpoint, 'endpoint = ' + endpoint);
try { new URL(endpoint.split(',')[0].trim()); ok(true, 'endpoint 是合法 URL'); } catch { ok(false, 'endpoint 不是合法 URL'); }
const apiKey = q.get('apiKey');
ok(!!apiKey && apiKey.length > 0, 'apiKey 非空 (' + apiKey.length + ' 字符)');

console.log('— Claude 字段映射 —');
for (const [param, envKey] of [['model', 'ANTHROPIC_MODEL'], ['haikuModel', 'ANTHROPIC_DEFAULT_HAIKU_MODEL'],
                              ['sonnetModel', 'ANTHROPIC_DEFAULT_SONNET_MODEL'], ['opusModel', 'ANTHROPIC_DEFAULT_OPUS_MODEL']]) {
  ok(!!q.get(param), param + ' → ' + envKey + ' = ' + q.get(param));
}

// 四种 base64 引擎都试，和 Rust 侧 decode_base64_param 一致
function decodeB64(raw, label) {
  const trimmed = raw.replace(/[\r\n]/g, '');
  const candidates = [];
  if (trimmed.includes(' ')) candidates.push(trimmed.replace(/ /g, '+'));
  candidates.push(trimmed);
  for (const c of [...candidates]) {
    const rem = c.length % 4;
    if (rem) candidates.push(c + '='.repeat(4 - rem));
  }
  for (const c of candidates) {
    for (const enc of ['base64', 'base64url']) {
      try {
        const buf = Buffer.from(c, enc);
        const text = buf.toString('utf8');
        if (text && !text.includes('�')) return text;
      } catch { /* 换下一种 */ }
    }
  }
  throw new Error(label + ' 解不出来');
}

console.log('— config（会被合并进 env，URL 参数优先）—');
const configRaw = q.get('config');
if (configRaw) {
  ok(q.get('configFormat') === 'json', 'configFormat = json');
  const cfg = JSON.parse(decodeB64(configRaw, 'config'));
  ok(!!cfg.env && typeof cfg.env === 'object', 'config.env 是对象');
  console.log('    env = ' + JSON.stringify(cfg.env));
} else {
  console.log('  · 未附带 config');
}

console.log('— usageScript（cc-switch 的用量脚本契约）—');
const scriptRaw = q.get('usageScript');
if (scriptRaw) {
  ok(q.get('usageEnabled') === 'true', 'usageEnabled = true（必须显式携带才会启用）');
  const code = decodeB64(scriptRaw, 'usageScript');
  ok(/^\s*\(\{/.test(code), '脚本是 ({ ... }) 表达式');
  ok(/request\s*:/.test(code) && /extractor\s*:/.test(code), '含 request 与 extractor');
  ok(/Bearer \{\{apiKey\}\}/.test(code), '鉴权用 {{apiKey}} 占位符');
  ok(code.includes('{{baseUrl}}'), 'URL 用 {{baseUrl}} 占位符');
  ok(!!q.get('usageApiKey'), 'usageApiKey 已给（' + String(q.get('usageApiKey')).slice(0, 10) + '…）');
  ok(!!q.get('usageBaseUrl'), 'usageBaseUrl = ' + q.get('usageBaseUrl'));
  ok(/\d+/.test(String(q.get('usageAutoInterval'))), 'usageAutoInterval = ' + q.get('usageAutoInterval'));
  // 脚本能否真的跑起来：给一份假响应，看 extractor 的返回
  const reqUrl = code.match(/url:\s*"([^"]+)"/)[1]
    .replace('{{baseUrl}}', q.get('usageBaseUrl'));
  console.log('    实际请求地址 = ' + reqUrl);
  const fake = JSON.stringify({ success: true, data: { limits: [
    { type: 'five_hour', percentUsed: 2, resetsAt: new Date(Date.now() + 3600e3).toISOString() },
    { type: 'weekly', percentUsed: 2, resetsAt: new Date(Date.now() + 86400e3).toISOString() },
    { type: 'monthly', percentUsed: 1, resetsAt: new Date(Date.now() + 86400e3 * 20).toISOString() },
  ] } });
  const fn = new Function('return ' + code)();
  const out = fn.extractor(fake);
  console.log('    extractor 结果 = ' + JSON.stringify(out));
  ok(out.isValid === true && out.remaining === 98, 'extractor 对样例响应给出合理结果');
} else {
  console.log('  · 未附带用量脚本');
}

console.log(fail.length ? '\n结果：' + fail.length + ' 项未通过' : '\n结果：全部通过');
process.exit(fail.length ? 1 : 0);