// Cline Pass 上游观察/切换代理
// 零依赖，Node >= 18。
//
// 网关行为（实测结论，README 有证据）：
// - 订阅模型（cline-pass/*）与非 free 目录模型：请求体里的 provider.* 会被 Cline 网关丢弃，
//   由其规划器在系统凭证上游中自行挑选，响应元数据可回读实际上游。
// - 目录模型 :free 变体：provider.only 真正透传到 OpenRouter，可精确钉住。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { toChatRequest, toAnthropicResponse, createSseTranslator, estimateInputTokens } from './anthropic.js';
import { createUsageStore, scanClaudeSessions, normalizeUpstreamUsage, dayKey, hourKey } from './usage.js';
import { deepseekCostCny, DEEPSEEK_CNY, describeBand } from './pricing-cny.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || __dirname;
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const META_PATH = path.join(DATA_DIR, 'metadata.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const DEFAULT_CONFIG = {
  port: 3123,
  apiKey: '',
  proxyKey: '',
  publicBaseUrl: '',
  exposeCatalog: false,    // true 时 /v1/models 合并完整目录模型（默认仅订阅模型）
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: [],            // { name, key, enabled } —— Cline Pass 账号池
  accountMode: 'single',   // single=手动指定 | roundrobin=轮询
  activeAccount: 0,        // single 模式下使用的账号下标
  knownModels: [
    'cline-pass/glm-5.3-flash',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/deepseek-v4.1-flash',
    'cline-pass/qwen3.8-max',
    'cline-pass/minimax-m3',
    'cline-pass/glm-5.3',
    'cline-pass/glm-5.2',
    'cline-pass/deepseek-v4-pro',
    'cline-pass/mimo-v2.5-pro',
    'cline-pass/mimo-v2.5',
    'cline-pass/kimi-k2.6',
    'cline-pass/qwen3.7-plus',
    'cline-pass/kimi-k2.7-code',
    'cline-pass/qwen3.7-max',
  ],
  // modelId -> { upstreams: string[]（有序优先列表，空=自动）, exclude: string[]（排除列表，优先级高于勾选）,
  //              pinMode: 'strict'|'preferred', sort: 'cost'|'ttft'|'tps'|null }
  // 请求按 upstreams 顺序逐个钉住尝试：第一个异常（非 200 / 网络失败 / 超时）自动顺切下一个，
  // 全部失败才把最后一个错误透传给客户端；exclude 中的上游永不被使用（自动模式下注入排除偏好）。
  // upstream 为旧版单上游兼容镜像（取列表第一个），maxRetries 已退役（旧值仅作回滚兼容保留在文件里）。
  perModel: {},
};

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
const config = { ...DEFAULT_CONFIG, ...loadJson(CONFIG_PATH, {}) };
const META = loadJson(META_PATH, { models: {}, history: [], catalog: null, orModelsFetchedAt: 0, orModelList: null });
const saveConfig = () => fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
const saveMeta = () => fs.writeFileSync(META_PATH, JSON.stringify(META, null, 2));

// ---------- 用量统计 ----------
// 明细单独落 JSONL（append-only），不塞进 metadata.json —— 后者是渠道学习结果，
// 每请求全量覆写且已有 100 条历史上限，混在一起会把两边都置于截断风险中。
const USAGE = createUsageStore(path.join(DATA_DIR, 'usage'));
USAGE.prime();
// 会话记录目录：Claude Code 把每个会话写成 <配置目录>/projects/<项目>/<会话>.jsonl。
// 默认是 ~/.claude/projects，但用户可能用 CLAUDE_CONFIG_DIR 换过位置，
// 所以这里收一组候选目录，扫描时都过一遍（不存在的直接跳过）。
// CLAUDE_PROJECTS_DIR 可用 ; 或 , 分隔多个。
function claudeProjectsDirs() {
  const out = [];
  const push = (d) => { const s = String(d || '').trim(); if (s && !out.includes(s)) out.push(s); };
  if (process.env.CLAUDE_PROJECTS_DIR) {
    for (const p of process.env.CLAUDE_PROJECTS_DIR.split(/[;,]/)) push(p);
  }
  if (process.env.CLAUDE_CONFIG_DIR) push(path.join(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  push(path.join(os.homedir(), '.claude', 'projects'));
  return out;
}
// 旧版单 apiKey 迁移为账号池
if ((!Array.isArray(config.accounts) || config.accounts.length === 0) && config.apiKey) {
  config.accounts = [{ name: '默认账号', key: config.apiKey, enabled: true }];
  config.accountMode = 'single';
  config.activeAccount = 0;
  saveConfig();
}
config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single';

// perModel 配置升级：旧版单 upstream 迁移为有序多上游列表（upstream 保留为回滚兼容镜像）
(function migratePerModel() {
  let dirty = false;
  for (const c of Object.values(config.perModel || {})) {
    if (!c || typeof c !== 'object') continue;
    if (c.upstreams === undefined) { c.upstreams = c.upstream ? [c.upstream] : []; dirty = true; }
    if (c.exclude === undefined) { c.exclude = []; dirty = true; }
    if (!Array.isArray(c.upstreams)) { c.upstreams = []; dirty = true; }
    if (!Array.isArray(c.exclude)) { c.exclude = []; dirty = true; }
  }
  if (dirty) saveConfig();
})();

// 环境变量覆盖（便于 Docker 部署）。注意：此后若通过控制台保存设置，当前生效值会写回 config.json
if (process.env.CLINE_PASS_KEY) {
  const k = process.env.CLINE_PASS_KEY.trim();
  if (k && !(config.accounts || []).some((a) => a.key === k)) {
    config.accounts = [{ name: 'env-account', key: k, enabled: true }, ...(config.accounts || [])];
  }
}
if (process.env.PROXY_KEY && process.env.PROXY_KEY.trim()) config.proxyKey = process.env.PROXY_KEY.trim();
if (process.env.PUBLIC_BASE_URL) config.publicBaseUrl = process.env.PUBLIC_BASE_URL.trim();
if (process.env.PORT) config.port = Number(process.env.PORT) || config.port;

function isConfigured() {
  return !!config.apiKey || enabledAccounts().length > 0;
}
if (!isConfigured()) {
  console.warn('[提示] 尚未配置上游 API Key：打开控制台「账号管理」添加账号并保存即可；服务已启动。');
}

// 账号选择：roundrobin 在启用的账号间轮询；single 使用 activeAccount 指定的账号
let RR_COUNTER = 0;
function enabledAccounts() {
  return (config.accounts || []).filter((a) => a && a.key && a.enabled !== false);
}
function pickAccount() {
  const list = enabledAccounts();
  if (!list.length) return { name: '默认', key: config.apiKey || '' };
  if (config.accountMode === 'roundrobin' && list.length > 1) {
    const a = list[RR_COUNTER % list.length];
    RR_COUNTER = (RR_COUNTER + 1) % 1000000000;
    return a;
  }
  const byIdx = config.accounts[config.activeAccount];
  if (byIdx && byIdx.key && byIdx.enabled !== false) return byIdx;
  return list[0];
}
const chatHeaders = (key) => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${key}`,
});

// 代理密钥：非空时，/v1/* 与 /api/* 均需鉴权（Authorization: Bearer <key> 或 X-Admin-Key: <key>）；
// 控制台页面本身保持开放（不含任何敏感数据，数据由带鉴权的 /api/* 提供）。
// 可通过 POST /api/security 在运行期修改（下游密钥 = 客户端访问代理的凭据）。
let PROXY_KEY = config.proxyKey || '';
function authOK(req) {
  if (!PROXY_KEY) return true;
  const bearer = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '').trim();
  const admin = String(req.headers['x-admin-key'] || '').trim();
  // Anthropic 协议的客户端（Claude Code）用 x-api-key 带凭据，不是 Authorization
  const apiKey = String(req.headers['x-api-key'] || '').trim();
  return bearer === PROXY_KEY || admin === PROXY_KEY || apiKey === PROXY_KEY;
}
function unauthorized(res) {
  return sendJSON(res, 401, { error: { message: 'unauthorized: 代理密钥缺失或错误', type: 'auth_error' } });
}
function publicProxyBase() {
  return config.publicBaseUrl
    ? `${config.publicBaseUrl.replace(/\/+$/, '')}/v1`
    : `http://127.0.0.1:${config.port}/v1`;
}

const OR_API = 'https://openrouter.ai/api/v1';

async function fetchJSON(url, opts = {}, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json };
  } finally {
    clearTimeout(t);
  }
}

// ---------- OpenRouter 目录缓存与 slug 归一化 ----------
async function orModelList() {
  if (META.orModelList && Date.now() - META.orModelsFetchedAt < 6 * 3600e3) return META.orModelList;
  const { json } = await fetchJSON(`${OR_API}/models`);
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) {
    META.orModelList = ids;
    META.orModelsFetchedAt = Date.now();
    saveMeta();
  }
  return ids;
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function orEndpoints(slug) {
  // canonicalSlug 与 OpenRouter 目录 id 可能存在连字符差异（zai/... vs z-ai/...），先精确后归一匹配
  const ids = await orModelList();
  let real = ids.find((id) => id === slug) || ids.find((id) => norm(id) === norm(slug));
  if (!real) return { slug, endpoints: [] };
  const { json } = await fetchJSON(`${OR_API}/models/${real}/endpoints`);
  const eps = json?.data?.endpoints || [];
  const detail = {};
  for (const e of eps) {
    const pSlug = String(e.tag || '').split('/')[0] || (e.provider_name || '').toLowerCase().replace(/\s+/g, '-');
    const d = (detail[pSlug] ||= { slug: pSlug, name: e.provider_name, endpoints: 0, context: 0, uptime: 0 });
    d.endpoints++;
    d.context = Math.max(d.context, e.context_length || 0);
    d.uptime = Math.max(d.uptime, Math.round(e.uptime_last_30m || 0));
  }
  return { slug: real, endpoints: Object.values(detail) };
}

// ---------- 探测单个模型 ----------
// 两条管道（实测）：
// - planner：响应带 provider_metadata.gateway.routing（canonicalSlug/finalProvider/fallbacksAvailable），
//   请求体 provider.* 被网关丢弃。
// - direct：响应顶层带 provider（显示名）与 model（真实 OpenRouter ID），provider.only 会透传到
//   OpenRouter，可精确钉住。
function slugify(s) { return String(s).toLowerCase().replace(/\s+/g, '-'); }

function parseRouting(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  const msg = d?.choices?.[0]?.message;
  const rt = msg?.provider_metadata?.gateway?.routing || d?.provider_metadata?.gateway?.routing || {};
  const direct = typeof d?.provider === 'string' ? d.provider : null;
  return {
    content: msg?.content ?? null,
    usage: d?.usage || null,
    pipeline: rt.finalProvider ? 'planner' : direct ? 'direct' : null,
    canonicalSlug: rt.canonicalSlug || (typeof d?.model === 'string' && d.model.includes('/') ? d.model : null),
    finalProvider: rt.finalProvider || (direct ? slugify(direct) : null),
    finalProviderName: rt.finalProvider || direct,
    fallbacks: rt.fallbacksAvailable || [],
    plan: rt.planningReasoning || '',
  };
}

// 故意携带不存在的 only，让网关在路由层报错并列出可用上游（不产生 token 消耗）。
// - 直连管道（OpenRouter）：provider.only → 404 错误 JSON 里的 metadata.available_providers
// - 规划器管道（Vercel AI Gateway）：providerOptions.gateway.only → 400 错误文本里的 "Available providers are: ..."
async function harvestAvailableProviders(modelId, pipeline) {
  const acc = pickAccount();
  const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
  const body = pipeline === 'planner'
    ? { ...base, providerOptions: { gateway: { only: ['__probe__'] } } }
    : { ...base, provider: { only: ['__probe__'] } };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body) }, 60000);
  const err = json?.error;
  if (typeof err !== 'string') return null;
  if (pipeline === 'planner') {
    const m = /Available providers are:\s*([^.]+)/.exec(err);
    if (!m) return null;
    // 错误文本里可能混有 JSON 片段（如 ","type":"invalid_request_error"），必须按 slug 格式过滤
    const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
    return toks.length ? toks : null;
  }
  const i = err.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(err.slice(i))?.error?.metadata?.available_providers || null;
  } catch { return null; }
}
function parseTier0(plan) {
  const m = /([\w-]+) won tier 0 over ([^."]+)/.exec(plan || '');
  if (!m) return [];
  return [...new Set([m[1], ...m[2].split(/,\s*|\s+and\s+/).map((s) => s.trim()).filter(Boolean)])];
}

async function probeModel(modelId) {
  const acc = pickAccount();
  const t0 = Date.now();
  const body = { model: modelId, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
  const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
    method: 'POST',
    headers: chatHeaders(acc.key),
    body: JSON.stringify(body),
  }, 180000);
  const ms = Date.now() - t0;
  if (json?.error && !json?.data) {
    return { ok: false, error: typeof json.error === 'string' ? json.error : JSON.stringify(json.error) };
  }
  const r = parseRouting(json);
  let harvest = null;
  if (r.pipeline) harvest = await harvestAvailableProviders(modelId, r.pipeline);
  let endpoints = [];
  let orSlug = null;
  if (r.pipeline !== 'planner' && r.canonicalSlug) {
    // 规划器管道的钉住发生在 Vercel 侧，OpenRouter 的 endpoint 明细仅对直连管道有参考意义
    try {
      const res = await orEndpoints(r.canonicalSlug);
      endpoints = res.endpoints;
      orSlug = res.slug;
    } catch { /* 公开接口失败不影响探测结果 */ }
  }
  const prev = META.models[modelId] || {};
  const detail = { ...prev.upstreamDetail };
  for (const e of endpoints) detail[e.slug] = e;
  const upstreams = r.pipeline === 'planner'
    ? [...new Set([...(harvest || []), ...r.fallbacks])]
    : [...new Set([...r.fallbacks, ...(harvest || []), ...Object.keys(detail)])];
  const tier0 = [...new Set([...(prev.tier0 || []), ...parseTier0(r.plan)])];
  META.models[modelId] = {
    ...prev,
    ok: true,
    pipeline: r.pipeline,
    pinnable: !!r.pipeline,
    availableProviders: harvest || prev.availableProviders || [],
    canonicalSlug: r.canonicalSlug,
    openrouterSlug: orSlug,
    upstreamDetail: detail,
    upstreams,
    tier0,
    lastProvider: r.finalProvider || prev.lastProvider,
    lastMs: ms,
    probedAt: Date.now(),
  };
  saveMeta();
  return { ok: true, ms, ...META.models[modelId] };
}

// 上游渠道可用性分类：渠道被单独钉住时的真实状态
function classifyUpstreamError(msg) {
  const m = String(msg || '');
  if (/empty response content/i.test(m)) return 'ok';                     // 请求已到达模型（推理耗尽 max_tokens 导致内容为空）
  if (/429|rate-?limited|temporarily rate/i.test(m)) return 'limited';   // 渠道有效，共享池限流中
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m)) return 'bad'; // 不可钉住
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';        // 账号 key 问题，与渠道无关
  return 'unknown';
}
// 钉住请求失败时自动学习该渠道状态（仅确定性失败，瞬时限流标 limited 不拉黑）
function learnUpstreamStatus(modelId, upstream, errMsg) {
  if (!upstream || !errMsg) return;
  const st = classifyUpstreamError(errMsg);
  if (st === 'unknown') return;
  const meta = (META.models[modelId] ||= {});
  meta.upstreamStatus = { ...(meta.upstreamStatus || {}), [upstream]: { status: st, note: String(errMsg).slice(0, 160), checkedAt: Date.now() } };
}

// 自动+排除模式：only 白名单与网关侧渠道清单不一致时，网关报错会附最新清单，合并学习
// （触发场景：探测缓存过期，网关侧新增了渠道而本地 known 列表没有——白名单漏掉新渠道）
function learnAvailableProviders(modelId, errMsg) {
  const m = /Available providers are:\s*([^.]+)/.exec(String(errMsg || ''));
  if (!m) return;
  const toks = m[1].split(/,\s*/).map((s) => s.trim()).filter((t) => /^[a-z0-9][a-z0-9-]*$/.test(t));
  if (!toks.length) return;
  const meta = (META.models[modelId] ||= {});
  const before = (meta.upstreams || []).length;
  meta.upstreams = [...new Set([...(meta.upstreams || []), ...toks])];
  if (meta.upstreams.length !== before) saveMeta();
}

// 批量校验：把模型的每个上游渠道用最小请求各钉一次，标记真实可用性
async function validateUpstreams(modelId) {
  const meta = META.models[modelId] || {};
  const list = meta.upstreams || [];
  const pipeline = meta.pipeline;
  const acc = pickAccount();
  const results = {};
  const batch = 5;
  for (let i = 0; i < list.length; i += batch) {
    await Promise.all(list.slice(i, i + batch).map(async (slug) => {
      const t0 = Date.now();
      const base = { model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 };
      const body = pipeline === 'planner'
        ? { ...base, providerOptions: { gateway: { only: [slug] } } }
        : { ...base, provider: { only: [slug] } };
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(body),
      }, 60000).catch(() => ({ json: { error: 'network error' } }));
      let status = 'unknown';
      let note = '';
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        status = classifyUpstreamError(msg);
        note = msg.slice(0, 160);
      } else if (json?.data?.choices || json?.choices) {
        status = 'ok';
      }
      results[slug] = { status, ms: Date.now() - t0, note };
    }));
  }
  META.models[modelId] = { ...meta, upstreamStatus: { ...(meta.upstreamStatus || {}), ...results }, validatedAt: Date.now() };
  saveMeta();
  return results;
}

// 从官方接口、官方文档与社区注册表拉取最新 ClinePass 订阅模型清单（只增不删）
async function fetchOfficialModels() {
  const found = new Set();
  const sources = [];
  const addModel = (value) => {
    const id = typeof value === 'string' ? value : value?.id;
    if (typeof id !== 'string') return;
    const normalized = id.trim().toLowerCase();
    if (normalized.startsWith('cline-pass/')) found.add(normalized);
  };
  // 官方推荐模型接口：Cline 自己用来列出订阅模型，权威且更新最快（无需鉴权）
  try {
    const { json } = await fetchJSON('https://api.cline.bot/api/v1/ai/cline/recommended-models', {}, 30000);
    const list = json?.clinePass || json?.data?.clinePass;
    if (Array.isArray(list) && list.length) {
      list.forEach(addModel);
      sources.push('cline.api');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 社区注册表 models.dev：历史响应包在 providers 下，新响应直接以 provider id 为顶层键
  try {
    const { json } = await fetchJSON('https://models.dev/api.json', {}, 30000);
    const cp = json?.providers?.['cline-pass'] || json?.['cline-pass'];
    if (cp?.models) {
      Object.keys(cp.models).forEach((id) => addModel(id.startsWith('cline-pass/') ? id : `cline-pass/${id}`));
      sources.push('models.dev');
    }
  } catch { /* 来源不可用则跳过 */ }
  // 官方文档表格兜底
  try {
    const res = await fetch('https://docs.cline.bot/getting-started/clinepass', { signal: AbortSignal.timeout(30000) });
    const text = await res.text();
    const ids = text.match(/cline-pass\/[a-z0-9._-]+/gi) || [];
    if (ids.length) { ids.forEach((id) => found.add(id.toLowerCase())); sources.push('docs.cline.bot'); }
  } catch { /* 来源不可用则跳过 */ }
  const valid = [...found].filter((id) => /^cline-pass\/[a-z0-9._-]+$/.test(id));
  const added = valid.filter((id) => !config.knownModels.includes(id));
  if (added.length) {
    config.knownModels.push(...added);
    saveConfig();
  }
  META.officialModelsFetch = { ts: Date.now(), sources, found: valid.length, added, total: config.knownModels.length };
  saveMeta();
  return { sources, found: valid.length, added, knownModels: config.knownModels, ...META.officialModelsFetch };
}

function record(modelId, info) {
  META.models[modelId] = { ...(META.models[modelId] || {}), ...info };
  META.history.unshift({ ts: Date.now(), model: modelId, ...info });
  if (META.history.length > 100) META.history.length = 100;
  if (info.account) {
    META.stats = META.stats || {};
    const st = (META.stats[info.account] ||= { requests: 0, lastUsed: 0, lastError: null });
    st.requests += 1;
    st.lastUsed = Date.now();
    st.lastError = info.error || null;
  }
  saveMeta();
}

// 每条用量记下来之后的通知回调。桌面端在启动时注册，用来把新记录推给界面
// （「实时加载」靠它，而不是等下一次轮询）。命令行单独跑时没人注册，是空操作。
let onUsageRecord = null;
function setUsageSink(fn) { onUsageRecord = typeof fn === 'function' ? fn : null; }

// 记一条用量明细。与 record() 分开在两个地方写：
// - record() 进 metadata.json，是「渠道学习 + 最近 100 条」的老结构，保持不变
// - recordUsage() 进 usage.jsonl，是逐条用量账本，只追加、不覆写
//
// 成本口径：上游网关返回的真实成本（provider_metadata.gateway.cost）优先；
// 拿不到时用定价表估算。两者在汇总里分开累计（costReal / costEstimated），
// 免得把估算值混进真实账单里还以为那是真的。
function recordUsage(modelId, {
  ts = Date.now(), usage = null, requestModel = null, canonical = null,
  provider = null, account = null, ms = 0, firstTokenMs = null,
  stream = false, error = null, requestId = null, source = 'proxy', sessionId = null,
} = {}) {
  try {
    const tok = usage ? normalizeUpstreamUsage(usage) : null;
    const t = tok || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, total: 0, realCost: null };
    let cost = null;
    let costSource = null;
    if (t.realCost != null) {
      cost = t.realCost;
      costSource = 'real';
    } else {
      const est = USAGE.estimateCost(modelId, t);
      if (est) { cost = est.cost; costSource = 'estimated'; }
    }
    // 人民币那一栏：按 DeepSeek 官方价目表独立算一遍（含峰谷时段），
    // 与上面的美元**互不覆盖** —— 一个是上游账单，一个是官网价，回答的是两个问题。
    // 认不出模型的（k3 / glm 等）保持 null，界面按「没有人民币价」显示，不冒充 0 元。
    const cny = deepseekCostCny(modelId, {
      input: t.input, output: t.output, cacheRead: t.cacheRead,
      cacheCreation: t.cacheCreation, canonical, pricingModel: requestModel,
    }, ts);
    const entry = {
      id: requestId || `proxy:${ts}:${Math.random().toString(36).slice(2, 10)}`,
      ts, source,
      model: modelId,
      requestModel: requestModel || modelId,
      canonical: canonical || null,
      provider: provider || null,
      account: account || null,
      input: t.input, output: t.output, cacheRead: t.cacheRead, cacheCreation: t.cacheCreation,
      total: t.total,
      cost, costSource,
      costCny: cny ? cny.cost : null,
      costCnyPeak: cny ? cny.peak : null,
      cnyPricingKey: cny ? cny.pricingKey : null,
      ms, firstTokenMs, stream,
      error: error || null,
      sessionId,
    };
    if (USAGE.add(entry)) {
      // 让界面能真正「实时」看到新记录，而不是等下一次轮询。
      // 回调不存在时（命令行独立运行）就是空操作。
      try { if (typeof onUsageRecord === 'function') onUsageRecord(entry); } catch { /* 推送失败不影响记录 */ }
    }
  } catch (e) {
    // 统计失败绝不能影响代理本身 —— 记一笔日志继续跑（日志经 console 汇入主进程缓冲区）
    console.warn(`[用量] 记录失败（已忽略）：${e.message}`);
  }
}

// 从上游原始响应里取 usage（非流式路径）。上游可能把它放在顶层或 data 里。
function usageOf(out) {
  if (!out || typeof out !== 'object') return null;
  return out.usage || (out.data && out.data.usage) || null;
}

// ---------- 聊天代理 ----------
const CHAT_PATHS = new Set(['/chat/completions', '/v1/chat/completions', '/api/v1/chat/completions']);
// Anthropic Messages：Claude Code 直连本机代理时走这条。请求/响应/流式都靠 anthropic.js 翻译，
// 上游仍走同一套 Chat Completions 链路（钉住、故障转移、学习、记录都不变）。
// 额外收下 /v1/v1 这种写法：客户端会往 ANTHROPIC_BASE_URL 后面拼 /v1/messages，而很多人
// （含 cc-switch 写供应商环境变量时）会把 base 填成 .../v1，拼出来就是 /v1/v1/messages。
// 与其让用户去猜该不该带 /v1，不如两种都认。
const MESSAGES_PATHS = new Set(['/messages', '/v1/messages', '/api/v1/messages', '/v1/v1/messages']);
const COUNT_TOKENS_PATHS = new Set([
  '/messages/count_tokens',
  '/v1/messages/count_tokens',
  '/api/v1/messages/count_tokens',
  '/v1/v1/messages/count_tokens',
]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 50 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unwrap(json) {
  const d = json?.data && json.data.choices ? json.data : json;
  if (d?.error && !d?.choices) {
    const msg = typeof d.error === 'string' ? d.error : JSON.stringify(d.error);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return { status, body: { error: { message: msg, type: 'upstream_error' } }, routing: {} };
  }
  const r = parseRouting(d);
  return { status: 200, body: d, routing: r };
}

// 按管道注入上游偏好（实测结论）：
// - 规划器管道（Vercel AI Gateway）：顶层 provider 简写里的 only/order 会被 Cline 吞掉，
//   必须用 providerOptions.gateway.{only,order,sort}；流式同样生效。
// - 直连管道（OpenRouter）：顶层 provider.{only,order,sort} 生效；providerOptions 被忽略。
// - 管道未知时两种形式同时注入，各自取用、互不干扰。
const OR_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' };

// upstream: 本次尝试钉住的上游（null=自动）；orderRest: preferred 模式下排在当前上游之后的回退序列；
// excludeList: 排除列表。网关不支持 exclude/ignore 字段（实测被静默忽略），因此排除统一换算成 only 白名单：
// 自动模式 only=已知上游-排除；preferred 钉住模式 order=[当前,...] 且 only=已知上游-排除（防止网关回退到被排除渠道）；
// 严格钉住模式 only=[当前上游]，天然排除其他一切渠道。
function injectPrefs(body, modelId, { upstream, orderRest = [], excludeList = [], strict = true, sort = null }) {
  const b = JSON.parse(JSON.stringify(body));
  const exclude = (excludeList || []).filter((u) => u !== upstream);
  const meta = META.models[modelId] || {};
  const known = meta.upstreams || [];
  const allowList = exclude.length ? known.filter((u) => !exclude.includes(u)) : null;
  if (!upstream && !sort && !(allowList && allowList.length)) return b;
  const pipeline = meta.pipeline || null;
  const useVercel = pipeline === 'planner' || pipeline === null;
  const useOpenRouter = pipeline === 'direct' || pipeline === null;
  if (useVercel) {
    const gw = {};
    if (upstream) {
      if (strict) gw.only = [upstream];
      else {
        gw.order = [upstream, ...orderRest];
        if (allowList && allowList.length) gw.only = allowList;
      }
    } else if (allowList && allowList.length) {
      gw.only = allowList;
    }
    if (sort) gw.sort = sort;
    b.providerOptions = { ...(b.providerOptions || {}), gateway: { ...(b.providerOptions?.gateway || {}), ...gw } };
  }
  if (useOpenRouter) {
    const p = { ...(b.provider || {}) };
    if (upstream) {
      if (strict) p.only = [upstream];
      else {
        p.order = [upstream, ...orderRest];
        if (allowList && allowList.length) p.only = allowList;
      }
    } else if (allowList && allowList.length) {
      p.only = allowList;
    }
    if (sort) p.sort = OR_SORT[sort] || sort;
    b.provider = p;
  }
  return b;
}

// 由 perModel 配置展开出故障转移候选序列：[{ upstream, orderRest, excludeList, strict, sort }, ...]
// - 勾选了上游（排除后非空）：逐个尝试，排除的永不在候选中
// - 未勾选：单候选自动模式，排除换算成 only 白名单注入（见 injectPrefs）
function buildAttempts(modelId, cfg) {
  const listed = (cfg?.upstreams || []).filter((u) => typeof u === 'string' && u);
  const exclude = (cfg?.exclude || []).filter((u) => typeof u === 'string' && u);
  const excl = new Set(exclude);
  const wanted = listed.filter((u) => !excl.has(u));
  const strict = (cfg?.pinMode || 'strict') === 'strict';
  const sort = cfg?.sort || null;
  const base = { strict, sort, excludeList: exclude };
  if (wanted.length) {
    // preferred 模式：当前上游排在 order 首位，其余勾选项作为网关侧回退序列；排除列表随行（限制网关回退范围）
    return wanted.map((u, i) => ({ ...base, upstream: u, orderRest: strict ? [] : wanted.filter((_, j) => j !== i) }));
  }
  return [{ ...base, upstream: null, orderRest: [], excludeList: exclude }];
}

// 把上游错误信息归一成短字符串（用于学习与尝试日志）
const errText = (e) => (e == null ? '' : typeof e === 'string' ? e : JSON.stringify(e));

// 单次向上游网关发起非流式请求；返回 { status, out, routing, netError, acc }
// 异常（网络错误/非 JSON/非 200）不抛出，由调用方决定切换
async function attemptOnce(modelId, body, attempt, signal) {
  const send = injectPrefs(body, modelId, attempt);
  const acc = pickAccount();
  try {
    const res = await fetch(`${config.upstreamBase}/chat/completions`, {
      method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal,
    });
    const json = await res.json().catch(() => null);
    if (!json) return { status: 502, out: { error: { message: 'upstream returned non-JSON', type: 'upstream_error' } }, routing: {}, netError: 'non-JSON response', acc };
    const { status, body: out, routing } = unwrap(json);
    return { status, out, routing, netError: null, acc };
  } catch (e) {
    return { status: 502, out: { error: { message: `upstream fetch failed: ${e.message}`, type: 'upstream_error' } }, routing: {}, netError: e.message, acc };
  }
}

// 顺序故障转移：依次执行候选，非 200 / 网络失败 / 超时即切换下一个；全部失败返回最后一次结果。
// 流式：首包前（网关以 JSON 而非 SSE 应答错误）仍可切换；SSE 一旦开始即透传，无法重试。
// 每次尝试有独立的超时中止（attemptTimeoutMs）；客户端断开会中止当前尝试。
// 返回 { status, out, routing, acc, trace, streamUp? } —— trace 为逐次尝试 [{ upstream, status, ms, note }]
async function runChatChain(req, body, modelId, cfg, { stream = false, attemptTimeoutMs = 120000 } = {}) {
  const attempts = buildAttempts(modelId, cfg);
  const trace = [];
  const t0 = Date.now();
  let last = null;
  let activeCtrl = null;            // 当前尝试的 AbortController；流式成功后保持指向该次 fetch，用于断连时中止上游 body
  let keepCloseHook = false;        // 流式 SSE 建立后，close 钩子要保留到流结束
  const onClientClose = () => { if (activeCtrl) activeCtrl.abort(); };
  req.on('close', onClientClose);
  try {
    for (const attempt of attempts) {
      const t1 = Date.now();
      const ctrl = new AbortController();
      activeCtrl = ctrl;
      const timer = setTimeout(() => ctrl.abort(), attemptTimeoutMs);
      try {
        if (stream) {
          const send = injectPrefs(body, modelId, attempt);
          const acc = pickAccount();
          let up = null;
          let netError = null;
          try {
            up = await fetch(`${config.upstreamBase}/chat/completions`, { method: 'POST', headers: chatHeaders(acc.key), body: JSON.stringify(send), signal: ctrl.signal });
          } catch (e) { netError = e.message; }
          const ctype = up?.headers?.get('content-type') || '';
          let isSSE = !!up && up.status === 200 && ctype.includes('event-stream');
          // 网关对流式错误可能返回 200 + text/event-stream，body 却是 {"error":...}：
          // 读首个数据块探测，真正的 SSE 第一行是 "data: {...}" 且非纯错误对象
          let firstChunk = null;
          if (isSSE) {
            let reader = null;
            try {
              reader = up.body.getReader();
              const { value, done } = await reader.read();
              if (done) {
                isSSE = false;
                netError = 'empty stream';
              } else {
                firstChunk = Buffer.from(value);
                const head = firstChunk.toString('utf8').trimStart().slice(0, 200);
                if (head.startsWith('data:')) {
                  const payload = head.replace(/^data:\s*/, '').slice(0, 160);
                  if (payload.startsWith('{"error"')) { isSSE = false; netError = `stream error: ${payload.slice(0, 120)}`; }
                } else {
                  isSSE = false;
                  netError = `unexpected stream head: ${head.slice(0, 60)}`;
                }
              }
            } catch (e) {
              isSSE = false;
              netError = e.message;
            } finally {
              try { reader?.releaseLock(); } catch {}
            }
          }
          const ms = Date.now() - t1;
          if (up && !isSSE) {
            let text = '';
            let json = null;
            if (firstChunk) {
              // 已消费的块 + 剩余 body 拼回完整错误文本
              const rest = await up.text().catch(() => '');
              text = firstChunk.toString('utf8') + rest;
            } else {
              text = await up.text();
            }
            try { json = JSON.parse(text); } catch {}
            const msg = errText(json?.error) || text.slice(0, 160) || netError;
            trace.push({ upstream: attempt.upstream, status: up.status, ms, note: msg.slice(0, 160) });
            if (attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, msg);
            if (!attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, msg);
            last = { status: json?.error ? 502 : up.status, out: json || { error: { message: text.slice(0, 400) || netError, type: 'upstream_error' } }, routing: parseRouting(json || {}), acc, netError: null };
            continue; // 错误：还未向客户端写任何字节，可切换下一候选
          }
          if (!up) {
            trace.push({ upstream: attempt.upstream, status: 502, ms, note: netError || 'no response' });
            last = { status: 502, out: { error: { message: `upstream fetch failed: ${netError || 'no response'}`, type: 'upstream_error' } }, routing: {}, acc, netError: netError || 'no response' };
            continue;
          }
          // 真 SSE：firstChunk 与剩余 body 串联透传（SSE 开始后无法重试）；close 钩子保留用于客户端断开时中止上游
          keepCloseHook = true;
          trace.push({ upstream: attempt.upstream, status: 200, ms, note: 'stream' });
          return { status: 200, streamUp: up, streamHead: firstChunk, acc, trace, t0 };
        }
        // 非流式
        const r = await attemptOnce(modelId, body, attempt, ctrl.signal);
        const ms = Date.now() - t1;
        const note = r.netError || (r.status !== 200 ? errText(r.out?.error?.message).slice(0, 160) : 'ok');
        trace.push({ upstream: attempt.upstream, status: r.status, ms, note });
        if (r.status !== 200 && attempt.upstream) learnUpstreamStatus(modelId, attempt.upstream, errText(r.out?.error?.message));
        if (r.status !== 200 && !attempt.upstream && (attempt.excludeList || []).length) learnAvailableProviders(modelId, r.netError || note);
        last = r;
        if (r.status === 200) break;
      } finally {
        clearTimeout(timer);
      }
    }
  } finally {
    if (!keepCloseHook) req.off('close', onClientClose);
  }
  return { ...last, status: last?.status ?? 502, trace, t0, netError: last?.netError || null };
}

// 从上游 SSE 原文里回读实际上游（供流式请求记录用，/v1/chat/completions 与 /v1/messages 共用）
// 顺带回收用量：上游把 usage 放在流的最后一个数据片里（实测确实有），
// 以及 gateway.generationId —— 那正是 Claude Code 会话记录里的 message.id，
// 用它做去重键，就能把「代理记的」和「扫会话扫到的」同一条请求认出来。
function sniffRouting(text) {
  let provider = null;
  let canonical = null;
  let generationId = null;
  let usage = null;
  // direct 管道：最后一个 chunk 顶层带 provider（显示名）与 model
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 10 && !provider; i--) {
    const l = lines[i];
    if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
    try {
      const c = JSON.parse(l.slice(6));
      if (typeof c.provider === 'string') { provider = slugify(c.provider); canonical = c.model || null; }
    } catch { /* 跳过不完整行 */ }
  }
  // planner 管道：final chunk 的 provider_metadata.gateway.routing
  if (!provider) {
    const fp = /"finalProvider":"([^"]+)"/.exec(text);
    const cs = /"canonicalSlug":"([^"]+)"/.exec(text);
    provider = fp ? fp[1] : null;
    canonical = cs ? cs[1] : null;
  }
  // 用量与 generationId：从后往前找带 usage 的那片（通常就是最后一片）
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('data: ') || l.includes('[DONE]')) continue;
    if (!usage && l.includes('"usage"')) {
      try {
        const c = JSON.parse(l.slice(6));
        if (c.usage && typeof c.usage === 'object') usage = c.usage;
      } catch { /* 跳过 */ }
    }
    if (!generationId && l.includes('generationId')) {
      const m = /"generationId":"([^"]+)"/.exec(l);
      if (m) generationId = m[1];
    }
    if (usage && generationId) break;
  }
  return { provider, canonical, generationId, usage };
}

async function handleChat(req, res) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, { error: { message: 'invalid JSON body' } }); }
  const modelId = body.model;
  if (!modelId) return sendJSON(res, 400, { error: { message: 'model is required' } });

  const cfg = config.perModel[modelId] || {};
  const targets = buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean);
  const isStream = !!body.stream;

  const chain = await runChatChain(req, body, modelId, cfg, { stream: isStream });

  if (isStream && chain.streamUp) {
    // 流式透传：先写已探测的首块，再接剩余 body；tap 在结束时回读路由元数据并记录
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    const ctype = up.headers.get('content-type') || 'text/event-stream';
    res.writeHead(up.status, {
      'Content-Type': ctype,
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
    });
    if (chain.streamHead) res.write(chain.streamHead);
    const buf = [];
    const tap = new Transform({
      transform(c, enc, cb) { buf.push(c); cb(null, c); },
      flush(cb) {
        const sn = sniffRouting(Buffer.concat(buf).toString('utf8'));
        const { provider, canonical } = sn;
        const ms = Date.now() - t0;
        record(modelId, { provider, canonical, ms, stream: true, error: null, account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto') });
        recordUsage(modelId, {
          ts: t0, usage: sn.usage, canonical, provider,
          account: acc.name, ms, stream: true, requestId: sn.generationId,
        });
        cb();
      },
    });
    Readable.fromWeb(up.body).pipe(tap).pipe(res);
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) return sendJSON(res, 502, { error: { message: 'no upstream response', type: 'upstream_error' } });
  // 客户端实际使用成功的新订阅模型自动收录进列表
  if (status === 200 && /^cline-pass\//.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
  });
  recordUsage(modelId, {
    ts: chain.t0, usage: usageOf(out), canonical: routing.canonicalSlug || null,
    provider: routing.finalProvider || null, account: acc ? acc.name : null,
    ms: Date.now() - chain.t0, stream: false,
    error: status !== 200 ? (out?.error?.message || 'upstream error') : null,
    requestId: out?.generationId || out?.id || null,
  });
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
  });
  res.end(JSON.stringify(out));
}

// Anthropic Messages 入口（Claude Code 直连）。协议翻译全在 anthropic.js，
// 这里只做三件事：把请求翻成 Chat、复用既有上游链路、把结果翻回 Anthropic 形状。
const anthErr = (type, message) => ({ type: 'error', error: { type, message } });

async function handleMessages(req, res, { countTokens = false } = {}) {
  const raw = await readBody(req);
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return sendJSON(res, 400, anthErr('invalid_request_error', 'invalid JSON body')); }

  if (countTokens) return sendJSON(res, 200, { input_tokens: estimateInputTokens(body) });

  const modelId = body.model;
  if (!modelId) return sendJSON(res, 400, anthErr('invalid_request_error', 'model is required'));
  if (!Array.isArray(body.messages) || !body.messages.length) {
    return sendJSON(res, 400, anthErr('invalid_request_error', 'messages must be a non-empty array'));
  }

  const chatBody = toChatRequest(body);
  const cfg = config.perModel[modelId] || {};
  const targets = buildAttempts(modelId, cfg).map((a) => a.upstream).filter(Boolean);
  const isStream = !!body.stream;
  const chain = await runChatChain(req, chatBody, modelId, cfg, { stream: isStream });

  if (isStream && chain.streamUp) {
    const up = chain.streamUp;
    const acc = chain.acc;
    const t0 = chain.t0;
    res.writeHead(up.status, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
      'X-Cline-Attempts': String(chain.trace.length),
      'X-Cline-Account': headerSafe(acc.name),
    });
    // 上游 Chat SSE → 客户端要的 Anthropic SSE；顺带用原文嗅探实际上游供记录
    const tr = createSseTranslator({ model: modelId });
    const tap = new Transform({
      transform(c, enc, cb) {
        try { cb(null, tr.push(c.toString('utf8'))); } catch (e) { cb(e); }
      },
      flush(cb) {
        try {
          const tail = tr.end();
          if (tail) this.push(tail);
          const sn = sniffRouting(tr.rawText);
          const ms = Date.now() - t0;
          record(modelId, { provider: sn.provider, canonical: sn.canonical, ms, stream: true, error: null, account: acc.name, attempts: chain.trace.map((t) => t.upstream || 'auto') });
          // 用量直接用翻译器解析好的（它已经按 Anthropic 口径算过缓存扣减），
          // 比再从原文里抠一遍更可靠；真实成本也从它那取。
          const u = tr.usage;
          recordUsage(modelId, {
            ts: t0,
            usage: {
              prompt_tokens: u.prompt_tokens, completion_tokens: u.output_tokens,
              prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens },
              cache_creation_input_tokens: u.cache_creation_input_tokens,
              cost: u.realCost,
            },
            canonical: sn.canonical, provider: sn.provider,
            account: acc.name, ms, stream: true, requestId: sn.generationId,
          });
          cb();
        } catch (e) { cb(e); }
      },
    });
    // 探测阶段已消费的首块也要过一遍翻译器，不能直接透传
    if (chain.streamHead) {
      const head = tr.push(chain.streamHead.toString('utf8'));
      if (head) res.write(head);
    }
    Readable.fromWeb(up.body).pipe(tap).pipe(res);
    return;
  }

  const { status, out, routing, acc } = chain;
  if (!out) return sendJSON(res, 502, anthErr('api_error', 'no upstream response'));
  if (status === 200 && /^cline-pass\//.test(String(modelId)) && !config.knownModels.includes(modelId)) {
    config.knownModels.push(modelId);
    saveConfig();
  }
  record(modelId, {
    provider: routing.finalProvider || null,
    canonical: routing.canonicalSlug || null,
    ms: Date.now() - chain.t0,
    stream: false,
    attempts: chain.trace.map((t) => t.upstream || 'auto'),
    trace: chain.trace,
    error: status !== 200 ? out?.error?.message || null : null,
    account: acc ? acc.name : null,
  });
  // 注意：用量取上游原始 out.usage，而不是翻译后的响应 —— 后者只保留
  // Anthropic 认识的字段，成本与缓存明细会丢。
  recordUsage(modelId, {
    ts: chain.t0, usage: usageOf(out), canonical: routing.canonicalSlug || null,
    provider: routing.finalProvider || null, account: acc ? acc.name : null,
    ms: Date.now() - chain.t0, stream: false,
    error: status !== 200 ? (out?.error?.message || 'upstream error') : null,
    requestId: out?.generationId || out?.id || null,
  });
  if (status !== 200) {
    return sendJSON(res, status, anthErr('api_error', out?.error?.message || 'upstream error'));
  }
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'X-Cline-Target-Upstream': targets.length ? targets.join('>') : 'auto',
    'X-Cline-Actual-Upstream': routing.finalProvider || 'unknown',
    'X-Cline-Canonical-Model': routing.canonicalSlug || '',
    'X-Cline-Attempts': String(chain.trace.length),
    'X-Cline-Account': headerSafe(acc ? acc.name : ''),
  });
  res.end(JSON.stringify(toAnthropicResponse(out, { model: modelId })));
}

// ---------- HTTP 服务 ----------
function sendJSON(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

async function catalog() {
  if (META.catalog && Date.now() - (META.catalogFetchedAt || 0) < 3600e3) return META.catalog;
  const { json } = await fetchJSON(`${config.upstreamBase}/models`, { headers: chatHeaders(pickAccount().key) });
  const ids = (json?.data || []).map((m) => m.id);
  if (ids.length) { META.catalog = ids; META.catalogFetchedAt = Date.now(); saveMeta(); }
  return META.catalog || [];
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && p === '/api/meta') {
      return sendJSON(res, 200, { authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), configured: isConfigured() });
    }
    if (p.startsWith('/api/') || p.startsWith('/v1/') || CHAT_PATHS.has(p) || MESSAGES_PATHS.has(p) || COUNT_TOKENS_PATHS.has(p)) {
      if (!authOK(req)) return unauthorized(res);
    }
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html')));
    }
    if (req.method === 'GET' && p === '/api/models') {
      const cat = await catalog();
      const sub = config.knownModels.map((id) => ({ id, config: config.perModel[id] || {}, meta: META.models[id] || null }));
      return sendJSON(res, 200, { subscription: sub, catalogCount: cat.length, catalog: cat, proxyBase: publicProxyBase(), officialFetch: META.officialModelsFetch || null });
    }
    if (req.method === 'POST' && p === '/api/probe') {
      const { model } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const r = await probeModel(model);
      return sendJSON(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && p === '/api/test') {
      // 临时配置可带 upstreams/exclude（数组）或旧版 upstream（单值），完整走故障转移链路
      const { model, upstream, upstreams, exclude } = await JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: 'model required' });
      const t0 = Date.now();
      const cfg = { ...(config.perModel[model] || {}) };
      if (upstreams !== undefined) cfg.upstreams = upstreams;
      else if (upstream !== undefined) cfg.upstreams = upstream ? [upstream] : [];
      if (exclude !== undefined) cfg.exclude = exclude;
      const body = { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 };
      const chain = await runChatChain(req, body, model, cfg, { stream: false, attemptTimeoutMs: 180000 });
      const trace = chain.trace || [];
      if (chain.status !== 200) {
        return sendJSON(res, 200, {
          ok: false, error: (chain.out?.error?.message || 'upstream error').slice?.(0, 400) || 'upstream error',
          targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [], trace,
        });
      }
      const r = parseRouting(chain.out);
      record(model, { provider: r.finalProvider, canonical: r.canonicalSlug, ms: Date.now() - t0, stream: false, attempts: trace.map((t) => t.upstream || 'auto'), error: null, account: chain.acc?.name || null });
      return sendJSON(res, 200, {
        ok: true, ms: Date.now() - t0,
        targets: (cfg.upstreams || []).filter(Boolean), exclude: cfg.exclude || [],
        actual: r.finalProvider, actualName: r.finalProviderName, pipeline: r.pipeline, pinnable: r.pipeline !== null,
        canonicalSlug: r.canonicalSlug, fallbacks: r.fallbacks, content: (r.content || '').slice(0, 120),
        account: chain.acc?.name || null, trace,
      });
    }
    if (req.method === 'GET' && p === '/api/accounts') {
      return sendJSON(res, 200, {
        accounts: config.accounts,
        mode: config.accountMode,
        active: config.activeAccount,
        stats: META.stats || {},
      });
    }
    if (req.method === 'POST' && p === '/api/accounts') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const accs = (Array.isArray(body.accounts) ? body.accounts : [])
        .map((a, i) => ({
          name: String(a.name || `账号${i + 1}`).slice(0, 50),
          key: String(a.key || '').trim(),
          enabled: a.enabled !== false,
        }))
        .filter((a) => a.key);
      if (!accs.length) return sendJSON(res, 400, { error: { message: '至少需要一个有效账号（key 非空）' } });
      config.accounts = accs;
      config.accountMode = body.mode === 'roundrobin' ? 'roundrobin' : 'single';
      config.activeAccount = Math.min(Math.max(0, Number(body.active) || 0), accs.length - 1);
      saveConfig();
      RR_COUNTER = 0;
      return sendJSON(res, 200, { ok: true, accounts: config.accounts.length, mode: config.accountMode, active: config.activeAccount });
    }
    if (req.method === 'POST' && p === '/api/accounts/test') {
      const { key } = JSON.parse(await readBody(req).then((b) => b.toString()));
      const k = String(key || '').trim();
      if (!k) return sendJSON(res, 400, { error: { message: 'key required' } });
      const t0 = Date.now();
      const model = config.knownModels[0] || 'cline-pass/glm-5.3-flash';
      const { json } = await fetchJSON(`${config.upstreamBase}/chat/completions`, {
        method: 'POST',
        headers: chatHeaders(k),
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
      }, 120000);
      if (json?.error && !json?.data) {
        const msg = typeof json.error === 'string' ? json.error : JSON.stringify(json.error);
        const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(msg);
        // 密钥无效会直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
        // 说明鉴权已通过，不应误报为密钥问题
        return sendJSON(res, 200, authFail
          ? { ok: false, ms: Date.now() - t0, error: `密钥无效或未授权：${msg.slice(0, 160)}` }
          : { ok: true, ms: Date.now() - t0, model, note: `密钥鉴权通过；网关提示：${msg.slice(0, 120)}` });
      }
      return sendJSON(res, 200, { ok: true, ms: Date.now() - t0, model });
    }
    if (req.method === 'GET' && p === '/api/security') {
      return sendJSON(res, 200, { proxyKey: config.proxyKey || '', publicBaseUrl: config.publicBaseUrl || '', authRequired: !!PROXY_KEY, exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/security') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.proxyKey !== undefined) config.proxyKey = String(body.proxyKey).trim();
      if (body.publicBaseUrl !== undefined) config.publicBaseUrl = String(body.publicBaseUrl).trim().replace(/\/+$/, '');
      if (body.exposeCatalog !== undefined) config.exposeCatalog = !!body.exposeCatalog;
      saveConfig();
      PROXY_KEY = config.proxyKey || '';
      return sendJSON(res, 200, { ok: true, proxyKey: config.proxyKey, publicBaseUrl: config.publicBaseUrl, authRequired: !!PROXY_KEY, proxyBase: publicProxyBase(), exposeCatalog: !!config.exposeCatalog });
    }
    if (req.method === 'POST' && p === '/api/validate-upstreams') {
      const { model } = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (!model) return sendJSON(res, 400, { error: { message: 'model required' } });
      const results = await validateUpstreams(model);
      const summary = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
      for (const r of Object.values(results)) summary[r.status] = (summary[r.status] || 0) + 1;
      return sendJSON(res, 200, { ok: true, summary, results, upstreams: META.models[model]?.upstreams || [] });
    }
    if (req.method === 'POST' && p === '/api/fetch-official-models') {
      const r = await fetchOfficialModels();
      return sendJSON(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && p === '/api/history') return sendJSON(res, 200, { history: META.history });
    // ---------- 用量统计 ----------
    // 按天返回汇总。默认只回最近 N 天，避免历史很长时一次吐太多；
    // 汇总已经按 账号/渠道/模型 分好桶，前端拿到直接画图。
    if (req.method === 'GET' && p === '/api/usage') {
      const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 30));
      // granularity=hour 时改回小时桶（「当天」这一档要看 0-23 点的曲线，
      // 一天只有一个点画不出趋势）。小时桶只保留近几天，超出范围时如实返回空。
      const gran = url.searchParams.get('granularity') === 'hour' ? 'hour' : 'day';
      const src = gran === 'hour' ? USAGE.hourly : USAGE.daily;
      const all = Object.keys(src).sort();
      // 起点：天粒度就是 (days-1) 天前那天；小时粒度必须是那天的 **00 点**。
      // 用 hourKey(now) 当起点是错的 —— 那会只留下「当前小时及以后」，
      // 于是「当天」看不到今天已经过去的那些小时（实测表现为「当天 0 次请求」）。
      const startDay = dayKey(Date.now() - (days - 1) * 86400e3);
      const cutoff = gran === 'hour' ? startDay + 'T00' : startDay;
      const picked = all.filter((d) => d >= cutoff);
      const out = picked.map((d) => ({ date: d, rollups: Object.values(src[d].rollups || {}) }));
      // available 描述的是**数据集本身的跨度**，一律按天取 ——
      // 小时粒度下若拿小时键当日期，界面会显示成「数据自 2026-09-21T03 起」这种怪东西。
      const allDays = Object.keys(USAGE.daily).sort();
      // 总计：跨所有选中日期再算一遍，前端不必自己合并
      const totals = { requests: 0, success: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, costReal: 0, costEstimated: 0, costCny: 0, costCnyPeak: 0, msSum: 0, msCount: 0 };
      for (const day of out) {
        for (const r of day.rollups) {
          totals.requests += r.requests; totals.success += r.success;
          totals.input += r.input; totals.output += r.output;
          totals.cacheRead += r.cacheRead; totals.cacheCreation += r.cacheCreation;
          totals.cost += r.cost || 0; totals.costReal += r.costReal || 0; totals.costEstimated += r.costEstimated || 0;
          totals.costCny += r.costCny || 0; totals.costCnyPeak += r.costCnyPeak || 0;
          totals.msSum += r.msSum; totals.msCount += r.msCount;
        }
      }
      return sendJSON(res, 200, {
        ok: true, days, granularity: gran,
        from: picked[0] || null, to: picked[picked.length - 1] || null,
        available: { from: allDays[0] || null, to: allDays[allDays.length - 1] || null, total: allDays.length },
        detailLines: USAGE.lines,
        sources: { dirs: claudeProjectsDirs().map((d) => ({ path: d, exists: fs.existsSync(d) })) },
        // 当前时段：界面要能说明「现在按高峰还是空闲计价」，否则用户看到价格变了会以为是 bug
        cny: {
          currency: 'CNY', symbol: DEEPSEEK_CNY.symbol,
          source: DEEPSEEK_CNY.source,
          modelCount: Object.keys(DEEPSEEK_CNY.models).length,
          now: describeBand(Date.now()),
        },
        daily: out, totals,
      });
    }
    // 扫描 Claude Code 的会话记录（不开代理也能统计）。增量：只读上次之后的新字节。
    // 候选目录可能有多个（默认位置 + CLAUDE_CONFIG_DIR 指定的），逐个扫，
    // 共用一个 store 与 sync —— 去重和增量游标因此是跨目录统一的。
    if (req.method === 'POST' && p === '/api/usage/scan') {
      const body = await readBody(req).then((b) => b.toString()).catch(() => '{}');
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch { /* 空 body 视为默认 */ }
      const since = Number(opts.sinceDays);
      const sinceDays = Number.isFinite(since) && since > 0 ? since : 30;
      const dirs = claudeProjectsDirs();
      const results = [];
      const total = { files: 0, scanned: 0, added: 0, skipped: 0, errors: [] };
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) { results.push({ dir, exists: false }); continue; }
        const r = scanClaudeSessions({ projectsDir: dir, sync: USAGE.sync, store: USAGE, sinceDays });
        results.push({ dir, exists: true, ...r });
        total.files += r.files; total.scanned += r.scanned;
        total.added += r.added; total.skipped += r.skipped;
        total.errors.push(...(r.errors || []));
      }
      return sendJSON(res, 200, { ok: true, ...total, sinceDays, dirs: results, detailLines: USAGE.lines });
    }
    // 明细：默认按**写入先后倒序**返回最近 N 条，支持按模型/来源/时间范围筛选。
    //
    // 为什么不再「从文件尾部读若干行」：会话扫描是按文件顺序追加的，而文件顺序
    // 不等于时间顺序（实测 1701 条里 57 条乱序）。只取尾部会漏掉真正最新的记录、
    // 又混进旧的。现在按写入序号 n 倒序取（见 usage.js 的 add），并把"时间倒序"
    // 作为最终排序键，两边都对得上。
    if (req.method === 'GET' && p === '/api/usage/records') {
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
      const fModel = url.searchParams.get('model') || '';
      const fSource = url.searchParams.get('source') || '';
      const fFrom = Number(url.searchParams.get('from')) || 0;
      const fTo = Number(url.searchParams.get('to')) || 0;
      const r = USAGE.recentRecords({ limit, model: fModel, source: fSource, from: fFrom, to: fTo });
      // 明确按时间倒序返回：写入序号是「后写的在前」，正常情况下与时间同序，
      // 但历史数据有乱序，这里再排一次保证界面拿到的就是严格的时间倒序。
      const records = r.records.slice().sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
      return sendJSON(res, 200, {
        ok: true, records, detailLines: r.detailLines, truncated: r.truncated,
        order: 'ts_desc',
      });
    }
    // 定价表：内置 + 用户自定义，供前端展示与「这个模型按什么价格算」
    if (req.method === 'GET' && p === '/api/usage/pricing') {
      return sendJSON(res, 200, { ok: true, pricing: USAGE.table, customPath: USAGE.paths.PRICING, custom: fs.existsSync(USAGE.paths.PRICING) });
    }
    if (req.method === 'POST' && p === '/api/usage/pricing') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      const patch = body && typeof body.pricing === 'object' ? body.pricing : {};
      // 只接受合法的四项数字；写进 pricing.json 覆盖内置表
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(USAGE.paths.PRICING, 'utf8')); } catch { /* 首次写入 */ }
      for (const [k, v] of Object.entries(patch)) {
        const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
        existing[k] = { n: String(v?.n || k), i: num(v?.i), o: num(v?.o), cr: num(v?.cr), cc: num(v?.cc) };
      }
      fs.writeFileSync(USAGE.paths.PRICING, JSON.stringify(existing, null, 2));
      return sendJSON(res, 200, { ok: true, pricing: { ...USAGE.table, ...existing } });
    }
    // 明细裁剪：把超期的逐条记录删掉（汇总不受影响）
    if (req.method === 'POST' && p === '/api/usage/compact') {
      const body = await readBody(req).then((b) => b.toString()).catch(() => '{}');
      let opts = {};
      try { opts = JSON.parse(body || '{}'); } catch { /* 默认 90 天 */ }
      const keepDays = Number(opts.keepDays);
      const r = USAGE.compact({ keepDays: Number.isFinite(keepDays) && keepDays > 0 ? keepDays : 90 });
      return sendJSON(res, 200, { ok: true, ...r, detailLines: USAGE.lines });
    }
    // 重算汇总与逐条的人民币金额。
    //
    // 为什么需要手动触发：人民币计价是后加的能力，老记录里没有 costCny，
    // 而汇总只在写入时累加 —— 不重算的话历史在界面上永远是 ¥0，
    // 新数据却有值，同一个页面一半有数一半是 0。
    // 不放在启动时自动跑：记录多的时候要重写整个明细文件，启动会被拖慢；
    // 由用户在用量页点一下更合适（也会明确告诉他发生了什么）。
    if (req.method === 'POST' && p === '/api/usage/recompute') {
      const r = USAGE.recompute();
      // 汇总变了，缓存里的 daily/hourly 已由 recompute 内部刷新
      return sendJSON(res, 200, { ok: true, ...r });
    }
    // 公开的定价资料：前端要展示「这个模型按什么价算」，以及当前处于高峰还是空闲。
    // 只读、不含任何密钥。
    if (req.method === 'GET' && p === '/api/usage/pricing-cny') {
      return sendJSON(res, 200, {
        ok: true,
        cny: {
          currency: DEEPSEEK_CNY.currency, symbol: DEEPSEEK_CNY.symbol, unit: DEEPSEEK_CNY.unit,
          source: DEEPSEEK_CNY.source, models: DEEPSEEK_CNY.models,
          peakWindows: DEEPSEEK_CNY.peakWindows,
          holidayYears: Object.keys(DEEPSEEK_CNY.holidays).map(Number).sort(),
        },
        now: describeBand(Date.now()),
      });
    }
    if (req.method === 'GET' && p === '/api/config') return sendJSON(res, 200, { port: config.port, perModel: config.perModel, knownModels: config.knownModels, usageCurrency: config.usageCurrency || 'auto' });
    if (req.method === 'POST' && p === '/api/config') {
      const body = JSON.parse(await readBody(req).then((b) => b.toString()));
      if (body.perModel) {
        for (const [m, c] of Object.entries(body.perModel)) {
          const normalize = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).trim()).filter(Boolean))].slice(0, 10);
          let upstreams = normalize(c.upstreams);
          const exclude = normalize(c.exclude);
          const excl = new Set(exclude);
          upstreams = upstreams.filter((u) => !excl.has(u)); // 同时出现以 exclude 为准
          const upstream = upstreams[0] || null; // 旧字段兼容镜像
          config.perModel[m] = {
            upstream,
            upstreams,
            exclude,
            pinMode: c.pinMode === 'preferred' ? 'preferred' : 'strict',
            sort: ['cost', 'ttft', 'tps'].includes(c.sort) ? c.sort : null,
          };
        }
        saveConfig();
      }
      // 用量页的花费口径：'auto'（美元优先）/ 'cny'（DeepSeek 用官方人民币价）/ 'usd'。
      // 只影响展示，不改任何记录 —— 记录里两种口径一直都存着。
      if (body.usageCurrency !== undefined) {
        const v = String(body.usageCurrency);
        config.usageCurrency = ['auto', 'cny', 'usd'].includes(v) ? v : 'auto';
        saveConfig();
      }
      return sendJSON(res, 200, { ok: true });
    }
    if (req.method === 'GET' && (p === '/v1/models' || p === '/api/v1/models' || p === '/models')) {
      // 默认只暴露订阅模型，避免目录模型淹没客户端的模型选择器；exposeCatalog=true 时合并完整目录
      const ids = config.exposeCatalog
        ? [...new Set([...config.knownModels, ...(await catalog())])]
        : [...new Set([...config.knownModels, ...Object.keys(config.perModel)])];
      return sendJSON(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (CHAT_PATHS.has(p) && req.method === 'POST') return handleChat(req, res);
    if (COUNT_TOKENS_PATHS.has(p) && req.method === 'POST') return handleMessages(req, res, { countTokens: true });
    if (MESSAGES_PATHS.has(p) && req.method === 'POST') return handleMessages(req, res);
    return sendJSON(res, 404, { error: { message: `no route: ${req.method} ${p}` } });
  } catch (e) {
    return sendJSON(res, 500, { error: { message: e.message } });
  }
});

// HTTP 响应头只允许 Latin-1，账号名里的中文等字符需要清洗（历史/统计仍用原名）
const headerSafe = (s) => String(s ?? '').replace(/[^\x20-\x7E]/g, '').trim().slice(0, 80) || '-';

// ---------- 宿主入口 ----------
// 相对原版 server.js 的唯一改动：不再在导入时自动 listen，改为导出 start/stop 供 Electron 主进程托管。
// 代理转发、上游钉住、探测/校验/学习等全部逻辑保持原样。
let BIND_HOST = process.env.BIND_HOST || '127.0.0.1';

function start({ host, port } = {}) {
  if (host) BIND_HOST = host;
  if (port) config.port = Number(port) || config.port;
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.off('error', onErr); reject(e); };
    server.once('error', onErr);
    server.listen(config.port, BIND_HOST, () => {
      server.off('error', onErr);
      resolve({ host: BIND_HOST, port: config.port });
    });
  });
}

function stop() {
  return new Promise((resolve) => {
    try { server.closeAllConnections?.(); } catch {}
    server.close(() => resolve());
  });
}

export {
  start,
  stop,
  config,
  META,
  USAGE,
  saveConfig,
  saveMeta,
  isConfigured,
  publicProxyBase,
  enabledAccounts,
  probeModel,
  validateUpstreams,
  fetchOfficialModels,
  learnUpstreamStatus,
  scanClaudeSessions,
  claudeProjectsDirs,
  setUsageSink,
};

// 直接用 node 运行本文件时，保持原版「启动即监听」的行为（便于脱离 Electron 调试）
const isDirectRun = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();
if (isDirectRun) {
  start()
    .then(({ port }) => {
      console.log(`Cline Pass 上游控制台:  http://127.0.0.1:${port}/`);
      console.log(`OpenAI 兼容代理地址:   http://127.0.0.1:${port}/v1`);
    })
    .catch((e) => {
      console.error(`[错误] 端口 ${config.port} 监听失败（可能被占用）：${e.message}`);
      process.exit(1);
    });
}
