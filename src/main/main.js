// Cline Pass Switcher —— Electron 主进程
// 职责：托管内嵌引擎（HTTP 代理 + 控制 API）、窗口/托盘/生命周期、把引擎配置暴露给渲染层。
import { app, BrowserWindow, ipcMain, Tray, Menu, shell, dialog, nativeImage, clipboard } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import * as claudeCfg from './claude-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.join(__dirname, '..', '..');
const RENDERER_DIR = path.join(APP_ROOT, 'src', 'renderer');

app.setAppUserModelId('com.clinepass.switcher');

// 单实例：第二次启动时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ---------- 数据目录 ----------
// 引擎通过 DATA_DIR 决定 config.json / metadata.json 的位置（沿用命令行版已有的约定）。
const USER_DATA = app.getPath('userData');
process.env.DATA_DIR = USER_DATA;

const SEED_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'seed')
  : path.join(APP_ROOT, 'resources', 'seed');

const APP_SETTINGS_PATH = path.join(USER_DATA, 'app-settings.json');

const DEFAULT_APP_SETTINGS = {
  autoLaunch: false,
  closeToTray: true,
  minimizeToTray: false,
  windowBounds: { width: 1240, height: 820 },
  lastView: 'overview',
};

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, obj) {
  try { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); } catch (e) { log('error', '写入失败 ' + file + ': ' + e.message); }
}

let appSettings = { ...DEFAULT_APP_SETTINGS, ...readJSON(APP_SETTINGS_PATH, {}) };
const saveAppSettings = () => writeJSON(APP_SETTINGS_PATH, appSettings);

// ---------- 日志（引擎用 console.* 输出，统一收进环形缓冲区并推给渲染层） ----------
const LOG_BUFFER = [];
const LOG_MAX = 500;

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    try { mainWindow.webContents.send(channel, payload); } catch { /* 窗口尚未就绪 */ }
  }
}

function log(level, message) {
  const entry = { ts: Date.now(), level, message: String(message) };
  LOG_BUFFER.push(entry);
  if (LOG_BUFFER.length > LOG_MAX) LOG_BUFFER.shift();
  broadcast('engine:log', entry);
}

for (const level of ['log', 'warn', 'error', 'info']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    log(level === 'info' ? 'log' : level, args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    original(...args);
  };
}

// ---------- 种子数据 ----------
// 首次启动时把随包携带的 metadata.json（上游渠道学习结果、目录缓存）复制进数据目录，
// 让新装用户不必从零探测。刻意不复制 config.json —— 其中含明文密钥，由用户在应用内填写。
function seedDataDir() {
  try {
    fs.mkdirSync(USER_DATA, { recursive: true });
    const src = path.join(SEED_DIR, 'metadata.json');
    const dst = path.join(USER_DATA, 'metadata.json');
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.copyFileSync(src, dst);
      log('log', '[种子] 已初始化 metadata.json');
    }
  } catch (e) {
    log('warn', '[种子] 初始化失败：' + e.message);
  }
}

// ---------- 引擎托管 ----------
let engine = null; // 动态导入的引擎模块
let engineState = { ok: false, port: null, host: null, error: null };

function setEngineState(patch) {
  engineState = { ...engineState, ...patch };
  broadcast('engine:state', engineState);
  updateTray();
}

async function ensureEngine() {
  if (!engine) {
    engine = await import('./engine/engine.js');
    log('log', '[引擎] 模块已加载');
    // 用量「实时」推送：引擎每记下一条用量就回调这里，直接转给渲染层。
    // 走这条内部回调而不是去解析日志文本 —— 日志是给人看的，格式随时会变，
    // 拿它当数据通道迟早会静默失效（改了文案就再也不推送了，而且不会报错）。
    try {
      engine.setUsageSink((entry) => broadcast('usage:record', entry));
    } catch (e) {
      log('warn', '[用量] 实时推送未挂上：' + e.message);
    }
  }
  return engine;
}

async function startEngine({ port } = {}) {
  try {
    const eng = await ensureEngine();
    const want = Number(port) || eng.config.port;
    const res = await eng.start({ host: '127.0.0.1', port: want });
    setEngineState({ ok: true, port: res.port, host: res.host, error: null });
    log('log', '[引擎] 已监听 http://' + res.host + ':' + res.port + '  （代理地址 http://' + res.host + ':' + res.port + '/v1）');
    return { ok: true, port: res.port, host: res.host };
  } catch (e) {
    const busy = !!(e && (e.code === 'EADDRINUSE' || /EADDRINUSE/.test(e.message || '')));
    const msg = busy
      ? '端口 ' + (port || (engine ? engine.config.port : '?')) + ' 已被占用，请换一个端口后重启服务'
      : '引擎启动失败：' + e.message;
    setEngineState({ ok: false, error: msg });
    log('error', '[引擎] ' + msg);
    return { ok: false, error: msg, busy };
  }
}

async function stopEngine() {
  if (!engine) return { ok: true };
  try {
    await engine.stop();
    setEngineState({ ok: false, port: null, host: null, error: null });
    log('log', '[引擎] 已停止');
    return { ok: true };
  } catch (e) {
    log('warn', '[引擎] 停止异常：' + e.message);
    return { ok: false, error: e.message };
  }
}

async function restartEngine({ port } = {}) {
  await stopEngine();
  const eng = await ensureEngine();
  if (port) eng.config.port = Number(port) || eng.config.port;
  const r = await startEngine({ port });
  if (r.ok) eng.saveConfig();
  return r;
}

// ---------- 窗口 ----------
let mainWindow = null;
let tray = null;
let quitting = false;

function iconPath(name = 'icon.png') {
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, 'build', name), path.join(process.resourcesPath, name)]
    : [path.join(APP_ROOT, 'build', name)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function createWindow() {
  const bounds = appSettings.windowBounds || DEFAULT_APP_SETTINGS.windowBounds;
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 940,
    minHeight: 620,
    show: false,
    backgroundColor: '#0e1319',
    title: 'Cline Pass Switcher',
    autoHideMenuBar: true,
    // 无边框 + 系统窗口控件叠加：Windows 保留原生最小化/最大化/关闭与窗口吸附，macOS 保留红绿灯
    titleBarStyle: 'hidden',
    ...(process.platform === 'darwin'
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: '#0e1319', symbolColor: '#9fb0c0', height: 44 } }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  // 渲染层的报错统一收进主日志，排查线上问题只靠一个日志抽屉
  mainWindow.webContents.on('console-message', (...args) => {
    const first = args[0];
    const d = first && typeof first === 'object' && 'message' in first
      ? first
      : { level: args[1], message: args[2], sourceId: args[4], lineNumber: args[3] };
    const rank = typeof d.level === 'number'
      ? d.level
      : ({ error: 3, warning: 2, warn: 2, info: 1, debug: 0 }[d.level] ?? 0);
    if (rank < 2) return;
    const where = d.sourceId ? ' (' + String(d.sourceId).split('/').pop() + ':' + (d.lineNumber || 0) + ')' : '';
    log(rank >= 3 ? 'error' : 'warn', '[渲染层] ' + String(d.message == null ? '' : d.message).slice(0, 500) + where);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log('error', '界面加载失败 ' + code + ' ' + desc + ' ' + url);
  });

  mainWindow.loadFile(path.join(RENDERER_DIR, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (e) => {
    if (!quitting && appSettings.closeToTray && tray) {
      e.preventDefault();
      mainWindow.hide();
      if (process.platform === 'darwin') app.dock?.hide?.();
    }
  });

  mainWindow.on('minimize', () => {
    if (appSettings.minimizeToTray && tray) mainWindow.hide();
  });

  const persistBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMaximized() || mainWindow.isFullScreen()) return;
    const b = mainWindow.getBounds();
    appSettings.windowBounds = { width: b.width, height: b.height, x: b.x, y: b.y };
    saveAppSettings();
  };
  mainWindow.on('resize', persistBounds);
  mainWindow.on('move', persistBounds);
  mainWindow.on('closed', () => { mainWindow = null; });

  // 外链一律走系统浏览器，窗口自身只加载本地文件
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  return mainWindow;
}

function showWindow() {
  if (!mainWindow) return createWindow();
  if (process.platform === 'darwin') app.dock?.show?.();
  mainWindow.show();
  mainWindow.focus();
  return mainWindow;
}

function updateTray() {
  if (!tray) return;
  const running = engineState.ok;
  tray.setToolTip(running ? 'Cline Pass Switcher — 运行中 :' + engineState.port : 'Cline Pass Switcher — 已停止');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: running ? '运行中 · 127.0.0.1:' + engineState.port : '服务已停止', enabled: false },
    { type: 'separator' },
    { label: '显示主窗口', click: () => showWindow() },
    {
      label: '复制代理地址',
      enabled: running,
      click: () => clipboard.writeText('http://127.0.0.1:' + engineState.port + '/v1'),
    },
    {
      label: '打开代理端口首页',
      enabled: running,
      click: () => shell.openExternal('http://127.0.0.1:' + engineState.port + '/'),
    },
    { type: 'separator' },
    { label: running ? '重启服务' : '启动服务', click: () => { restartEngine(); } },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  const p = iconPath('icon.png');
  if (!p) { log('warn', '[托盘] 未找到图标，跳过托盘创建'); return; }
  const img = nativeImage.createFromPath(p);
  tray = new Tray(img.resize({ width: 16, height: 16 }));
  updateTray();
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
}

// Cline 用量接口的基址：由 config.upstreamBase 推导（https://api.cline.bot/api/v1 -> https://api.cline.bot/api）
function quotaBase(eng) {
  const raw = (eng && eng.config && eng.config.upstreamBase) || 'https://api.cline.bot/api/v1';
  try {
    const u = new URL(raw);
    let p = u.pathname;
    if (p.endsWith('/v1')) p = p.slice(0, -3);
    while (p.endsWith('/')) p = p.slice(0, -1);
    return u.origin + p;
  } catch {
    return 'https://api.cline.bot/api';
  }
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('bootstrap', async () => {
    let eng = engine;
    if (!eng) { try { eng = await ensureEngine(); } catch { eng = null; } }
    return {
      platform: process.platform,
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      dataDir: USER_DATA,
      seedDir: SEED_DIR,
      // 系统语言：渲染层的 navigator.language 在部分环境不准，
      // 主进程的 app.getLocale() 才是权威来源，交给界面做语言自动切换
      systemLocale: app.getLocale(),
      engine: engineState,
      settings: appSettings,
      config: eng
        ? { port: eng.config.port, proxyKey: eng.config.proxyKey || '', publicBaseUrl: eng.config.publicBaseUrl || '', exposeCatalog: !!eng.config.exposeCatalog }
        : null,
      configured: eng ? eng.isConfigured() : false,
      proxyBase: eng && engineState.ok ? eng.publicProxyBase() : '',
    };
  });

  ipcMain.handle('engine:restart', (_e, opts) => restartEngine(opts || {}));
  ipcMain.handle('engine:stop', () => stopEngine());
  ipcMain.handle('engine:start', (_e, opts) => startEngine(opts || {}));
  ipcMain.handle('engine:status', () => engineState);
  ipcMain.handle('engine:logs', () => LOG_BUFFER);
  ipcMain.handle('engine:clearLogs', () => { LOG_BUFFER.length = 0; return { ok: true }; });

  ipcMain.handle('settings:get', () => appSettings);
  ipcMain.handle('settings:set', (_e, patch) => {
    appSettings = { ...appSettings, ...(patch || {}) };
    saveAppSettings();
    if (patch && 'autoLaunch' in patch) applyAutoLaunch(appSettings.autoLaunch);
    if (patch && 'closeToTray' in patch) updateTray();
    return appSettings;
  });

  // 引擎侧配置（写回 config.json，与命令行版共用同一份文件）
  ipcMain.handle('config:patch', async (_e, patch) => {
    const eng = await ensureEngine();
    const p = patch || {};
    if (p.port !== undefined) eng.config.port = Number(p.port) || eng.config.port;
    if (p.proxyKey !== undefined) eng.config.proxyKey = String(p.proxyKey).trim();
    if (p.publicBaseUrl !== undefined) eng.config.publicBaseUrl = String(p.publicBaseUrl).trim().replace(/\/+$/, '');
    if (p.exposeCatalog !== undefined) eng.config.exposeCatalog = !!p.exposeCatalog;
    eng.saveConfig();
    // 端口变化需要重启监听才生效；proxyKey 由 /api/security 走引擎自身逻辑
    const needsRestart = p.port !== undefined && Number(p.port) !== engineState.port;
    return {
      ok: true,
      needsRestart,
      config: { port: eng.config.port, proxyKey: eng.config.proxyKey || '', publicBaseUrl: eng.config.publicBaseUrl || '', exposeCatalog: !!eng.config.exposeCatalog },
    };
  });

  // ---------- 用量接口（Cline 官方，走主进程发起，避免渲染层被 CORS 挡住）----------
  ipcMain.handle('quota:fetch', async (_e, key) => {
    const k = String(key == null ? '' : key).trim();
    if (!k) return { ok: false, error: '该账号没有密钥' };
    const eng = await ensureEngine().catch(() => null);
    try {
      const res = await fetch(quotaBase(eng) + '/v1/users/me/plan/usage-limits', {
        method: 'GET',
        headers: {
          accept: '*/*',
          authorization: 'Bearer ' + k,
          'user-agent': 'cline-pass-switcher-desktop/' + app.getVersion(),
        },
        signal: AbortSignal.timeout(20000),
      });
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = null; }
      if (!res.ok) {
        let msg = (body && (body.error || body.message)) || ('HTTP ' + res.status);
        if (body && body.error && body.error.message) msg = body.error.message;
        return { ok: false, status: res.status, error: typeof msg === 'string' ? msg : JSON.stringify(msg) };
      }
      if (body && body.success === false) {
        return { ok: false, error: body.error || body.message || '套餐不可用或凭证已失效' };
      }
      const data = (body && body.data) || body || {};
      const limits = Array.isArray(data.limits) ? data.limits : [];
      if (!limits.length) return { ok: false, error: '未返回额度信息' };
      return {
        ok: true,
        planName: (data.plan && (data.plan.displayName || data.plan.name)) || 'Cline Pass',
        limits: limits.map((it) => ({
          type: it && it.type,
          percentUsed: Number(it && it.percentUsed) || 0,
          resetsAt: (it && it.resetsAt) || null,
        })),
        fetchedAt: Date.now(),
      };
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? '请求超时（20s）' : ((e && e.message) || String(e));
      log('warn', '读取用量失败：' + msg);
      return { ok: false, error: msg };
    }
  });

  // ---------- 经本机代理发一条真实请求 ----------
  // 必须走主进程：X-Cline-* 响应头在渲染层的 fetch 里会因为 CORS 被屏蔽。
  ipcMain.handle('proxy:chat', async (_e, payload) => {
    const p = payload || {};
    if (!engineState.ok) return { ok: false, status: 0, ms: 0, headers: {}, content: '', usage: null, error: '代理服务未运行', json: null };
    const eng = await ensureEngine().catch(() => null);
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (eng && eng.config.proxyKey) headers.authorization = 'Bearer ' + eng.config.proxyKey;
    const started = Date.now();
    try {
      const res = await fetch('http://127.0.0.1:' + engineState.port + '/v1/chat/completions', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: String(p.model || ''),
          messages: [{ role: 'user', content: String(p.prompt == null ? '' : p.prompt) }],
          max_tokens: Number(p.maxTokens) || 256,
          stream: false,
        }),
        signal: AbortSignal.timeout(180000),
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      const meta = {};
      for (const [name, value] of res.headers) {
        if (name.toLowerCase().startsWith('x-cline-')) meta[name.toLowerCase()] = value;
      }
      const choice = json && json.choices && json.choices[0];
      return {
        ok: res.ok,
        status: res.status,
        ms: Date.now() - started,
        headers: meta,
        content: (choice && ((choice.message && choice.message.content) || choice.text)) || '',
        usage: (json && json.usage) || null,
        error: res.ok ? null : ((json && json.error) || text.slice(0, 400) || ('HTTP ' + res.status)),
        json,
      };
    } catch (e) {
      const msg = e && e.name === 'TimeoutError' ? '请求超时（180s）' : ((e && e.message) || String(e));
      return { ok: false, status: 0, ms: Date.now() - started, headers: {}, content: '', usage: null, error: msg, json: null };
    }
  });

  // ---------- CC Switch 集成 ----------
  // 只认 ccswitch://v1/import 这一种深链接：新增供应商、写 live 配置、切换当前供应商、
  // 保存用量脚本都由 cc-switch 自己完成，比我们直接改它的 SQLite 安全得多。
  function ccswitchInfo() {
    const configDir = path.join(os.homedir(), '.cc-switch');
    const winExe = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'CC Switch', 'cc-switch.exe');
    return {
      platform: process.platform,
      configDir,
      hasConfigDir: fs.existsSync(configDir),
      hasApp: process.platform === 'darwin'
        ? fs.existsSync('/Applications/cc-switch.app')
        : fs.existsSync(winExe),
    };
  }
  ipcMain.handle('ccswitch:detect', () => ccswitchInfo());
  ipcMain.handle('ccswitch:open', (_e, link) => {
    const url = String(link == null ? '' : link);
    if (!url.toLowerCase().startsWith("ccswitch://v1/import?")) return { ok: false, error: "深链接格式不合法" };
    if (url.length > 64 * 1024) return { ok: false, error: '深链接过长' };
    shell.openExternal(url);
    return { ok: true };
  });

  // ---------- Claude Code 配置（~/.claude/settings.json）----------
  // 直接把本机代理写进 Claude Code 的全局配置，比 cc-switch 那条路少一层中间人。
  // 三条铁律都在 claude-config.js 里：只动我们负责的 env 键、写前必留备份、
  // 已有文件不是合法 JSON 就拒绝写入（不做猜测性修复）。
  const maskSecret = (key, v) => (v == null ? null : /TOKEN|KEY|SECRET/i.test(key) ? String(v).slice(0, 6) + '…' : String(v));

  // 各模型已知的最大上下文（来自上游渠道探测结果）。用于界面提示「这个模型到底有没有 1M」——
  // 不知道就返回 0，界面按「未知」显示，绝不替用户猜一个大数。
  async function modelContexts() {
    const out = {};
    try {
      const eng = await ensureEngine();
      for (const [id, m] of Object.entries((eng.META && eng.META.models) || {})) {
        let max = 0;
        for (const d of Object.values(m.upstreamDetail || {})) max = Math.max(max, Number(d.context) || 0);
        if (max > 0) out[id] = max;
      }
    } catch { /* 引擎没起来就没有上下文数据，界面会显示「未知」 */ }
    return out;
  }

  ipcMain.handle('claude:info', async () => {
    const p = claudeCfg.settingsPath();
    const cur = claudeCfg.readSettings(p);
    const backups = claudeCfg.listBackups(p);
    const env = cur.json && cur.json.env && typeof cur.json.env === 'object' ? cur.json.env : {};
    const curCtx = Number(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS);
    return {
      path: p,
      exists: cur.exists,
      valid: !cur.error,
      error: cur.error,
      topLevelKeys: Object.keys(cur.json || {}),
      currentBaseUrl: env.ANTHROPIC_BASE_URL || null,
      currentTokenMasked: maskSecret('TOKEN', env.ANTHROPIC_AUTH_TOKEN),
      currentModel: env.ANTHROPIC_MODEL || null,
      // 已经写过的窗口，用来把单选默认到用户上次的选择
      currentContextTokens: Number.isFinite(curCtx) && curCtx > 0 ? curCtx : null,
      contextOptions: claudeCfg.CONTEXT_OPTIONS,
      defaultContextTokens: claudeCfg.DEFAULT_CONTEXT_TOKENS,
      modelContexts: await modelContexts(),
      envCount: Object.keys(env).length,
      backups: backups.length,
      lastBackup: backups.length ? path.basename(backups[backups.length - 1]) : null,
      // 指向本机某个端口的，通常就是 cc-switch 这类切换器写的
      looksProxyManaged: /^https?:\/\/(127\.0\.0\.1|localhost):\d+/.test(String(env.ANTHROPIC_BASE_URL || '')),
    };
  });

  ipcMain.handle('claude:preview', (_e, payload) => {
    // 预览与写入共用 buildPlan：两边各算一次的话，预览说「会删掉 X」而写入没删，界面就骗人了。
    // result（写入后的完整文件）由 preview() 自己给，不在这里再 merge 一遍。
    const plan = claudeCfg.buildPlan(payload || {});
    const pv = claudeCfg.preview(plan.env, claudeCfg.settingsPath(), plan.remove);
    return { ...pv, env: plan.env };
  });

  ipcMain.handle('claude:write', (_e, payload) => {
    const plan = claudeCfg.buildPlan(payload || {});
    const r = claudeCfg.writeSettings(plan.env, claudeCfg.settingsPath(), plan.remove);
    log(r.ok ? 'log' : 'error', '[Claude 配置] ' + (r.ok
      ? '已写入 ' + r.path + (r.backupPath ? '（已备份 ' + path.basename(r.backupPath) + '）' : '（原来没有该文件）')
      : '写入失败：' + r.error));
    return r;
  });

  ipcMain.handle('claude:restore', () => {
    const r = claudeCfg.restoreLatest();
    log(r.ok ? 'log' : 'error', '[Claude 配置] ' + (r.ok ? '已从 ' + path.basename(r.restoredFrom) + ' 还原' : '还原失败：' + r.error));
    return r;
  });

  ipcMain.handle('claude:reveal', () => {
    const p = claudeCfg.settingsPath();
    if (fs.existsSync(p)) shell.showItemInFolder(p);
    else shell.openPath(path.dirname(p));
  });

  ipcMain.handle('app:openExternal', (_e, url) => { if (/^https?:/i.test(String(url))) shell.openExternal(String(url)); });  ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text == null ? '' : text)); return { ok: true }; });
  ipcMain.handle('app:openDataDir', () => shell.openPath(USER_DATA));
  ipcMain.handle('app:showWindow', () => { showWindow(); });
  ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });

  ipcMain.handle('config:export', async () => {
    const eng = await ensureEngine();
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: '导出配置',
      defaultPath: 'cline-pass-config-' + new Date().toISOString().slice(0, 10) + '.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(filePath, JSON.stringify(eng.config, null, 2));
      log('log', '[配置] 已导出到 ' + filePath);
      return { ok: true, filePath };
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('config:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: '导入配置',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths || !filePaths.length) return { ok: false, canceled: true };
    try {
      const incoming = JSON.parse(fs.readFileSync(filePaths[0], 'utf8'));
      const eng = await ensureEngine();
      for (const key of ['accounts', 'accountMode', 'activeAccount', 'knownModels', 'perModel', 'proxyKey', 'publicBaseUrl', 'exposeCatalog', 'upstreamBase', 'port']) {
        if (incoming[key] !== undefined) eng.config[key] = incoming[key];
      }
      eng.saveConfig();
      log('log', '[配置] 已从 ' + filePaths[0] + ' 导入');
      return { ok: true, filePath: filePaths[0], needsRestart: Number(incoming.port) !== engineState.port };
    } catch (e) { return { ok: false, error: '导入失败：' + e.message }; }
  });
}

function applyAutoLaunch(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true, args: ['--hidden'] });
  } catch (e) { log('warn', '[自启] 设置失败：' + e.message); }
}

// ---------- 生命周期 ----------
app.whenReady().then(async () => {
  seedDataDir();
  registerIpc();

  const startHidden = process.argv.includes('--hidden');
  createWindow();
  createTray();
  if (startHidden && mainWindow) mainWindow.once('ready-to-show', () => mainWindow.hide());

  const r = await startEngine();
  if (!r.ok) log('error', r.error);

  app.on('activate', () => { showWindow(); });
});

app.on('window-all-closed', () => {
  // 有托盘时常驻后台，服务继续为下游客户端提供代理
  if (process.platform !== 'darwin' && !appSettings.closeToTray) { quitting = true; app.quit(); }
});

app.on('before-quit', async () => {
  quitting = true;
  try { await stopEngine(); } catch { /* 忽略 */ }
});

process.on('uncaughtException', (e) => log('error', '[未捕获] ' + e.message));
process.on('unhandledRejection', (e) => log('error', '[未处理拒绝] ' + (e && e.message ? e.message : e)));
