// 应用外壳：启动引导、视图路由、引擎状态与日志抽屉
(function () {
  'use strict';

  const APP = {
    boot: null,
    engine: { ok: false, port: null, error: '' },
    config: null,
    accounts: [],
    accountsRaw: null,
    models: [],
    stats: {},
    view: 'overview',
    ready: false,
  };

  const ORDER = ['overview', 'accounts', 'models', 'playground', 'usage', 'history', 'catalog', 'settings'];

  // ---------- 状态条 ----------
  function paintConn() {
    const dot = document.getElementById('connDot');
    const text = document.getElementById('connText');
    const base = document.getElementById('connBase');
    const ok = APP.engine.ok;
    dot.className = 'dot ' + (ok ? 'is-ok' : 'is-bad');
    text.textContent = ok
      ? ('运行中 · ' + APP.engine.port)
      : (APP.engine.error ? '启动失败' : '已停止');
    const url = ok ? 'http://127.0.0.1:' + APP.engine.port + '/v1' : '—';
    base.textContent = url;
    document.getElementById('connPill').title = APP.engine.error || ('代理地址 ' + url);
  }

  // ---------- 数据 ----------
  async function refresh() {
    const boot = await window.cp.bootstrap();
    APP.boot = boot;
    // 标题栏版本号：同时跑着多个构建时靠它区分是哪一个
    const verEl = document.getElementById('brandVer');
    if (verEl) verEl.textContent = 'v' + (boot.version || '?');
    APP.engine = boot.engine || APP.engine;
    APP.config = boot.config || null;
    API.applyBootstrap(boot);
    paintConn();

    if (!APP.engine.ok) { APP.ready = true; return; }
    try {
      const [acct, models] = await Promise.all([API.accounts(), API.models()]);
      APP.accountsRaw = acct;
      APP.accounts = acct.accounts || [];
      APP.stats = acct.stats || {};
      APP.models = models.subscription || [];
    } catch (e) {
      // 引擎刚起来或正在重启：保留上一次的数据，只在控制台留痕
      console.warn('[app] 读取引擎数据失败：', e.message);
    }
    APP.ready = true;
  }

  // ---------- 路由 ----------
  async function nav(name, { force } = {}) {
    if (!window.VIEWS[name]) return;
    if (name === APP.view && !force) return;
    // 离开旧视图时给它一次收尾的机会。用量页靠这个停掉实时推送与轮询 ——
    // 不停的话切走之后它还在后台每 30 秒拉一次数据（白耗电、也可能打断正在进行的操作）。
    const prev = window.VIEWS[APP.view];
    if (prev && typeof prev.destroy === 'function') {
      try { prev.destroy(); } catch (e) { console.warn('[app] 视图收尾失败：', e && e.message); }
    }
    APP.view = name;
    for (const el of document.querySelectorAll('.nav-item')) {
      el.classList.toggle('is-active', el.getAttribute('data-view') === name);
    }
    await renderCurrent();
    window.cp.settings.set({ lastView: name }).catch(() => {});
  }

  async function renderCurrent() {
    const view = window.VIEWS[APP.view];
    const root = document.getElementById('view');
    const actions = document.getElementById('viewActions');
    document.getElementById('viewTitle').textContent = view.title;
    document.getElementById('viewSub').textContent = typeof view.sub === 'function' ? view.sub() : '';
    actions.innerHTML = typeof view.actions === 'function' ? view.actions() : '';
    paintConn();
    try {
      await view.load(root);
    } catch (e) {
      root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>渲染失败：' + U.esc(e.message) + '</div></div>';
    }
    // 副标题在 load 之后再刷一次。视图的 sub() 往往依赖 load 拿到的数据
    // （比如用量页要显示「近 7 天 67 次请求」），而上面那次是在数据到位前算的，
    // 结果会一直停在兜底文案上 —— 看起来像数据没加载出来。
    if (typeof view.sub === 'function') {
      document.getElementById('viewSub').textContent = view.sub();
    }
  }

  // ---------- 日志抽屉 ----------
  let logsOpen = false;
  function toggleLogs(force) {
    logsOpen = force === undefined ? !logsOpen : !!force;
    document.getElementById('logDrawer').hidden = !logsOpen;
    if (logsOpen) loadLogs();
  }

  async function loadLogs() {
    const r = await window.cp.engine.logs();
    const list = document.getElementById('logList');
    list.innerHTML = (r.logs || []).map(logRow).join('') || '<div class="empty">暂无日志</div>';
    list.scrollTop = list.scrollHeight;
  }

  function logRow(entry) {
    return '<div class="log-row ' + U.esc(entry.level || 'log') + '">' +
      '<span class="log-ts">' + U.fmtTime(entry.ts) + '</span>' +
      '<span class="log-lv">' + U.esc(String(entry.level || 'info').toUpperCase()) + '</span>' +
      '<span class="log-msg">' + U.esc(entry.message || '') + '</span></div>';
  }

  // ---------- 启动 ----------
  async function boot() {
    document.getElementById('brandMark').src = BRAND;
    // 版本号在 refresh() 里拿到 boot 数据之后再填（这里只先清空，别去读 APP.boot —— 那时它还是 null）

    for (const el of document.querySelectorAll('.nav-item')) {
      U.on(el, 'click', () => nav(el.getAttribute('data-view')));
    }
    U.on(document.getElementById('btnLogs'), 'click', () => toggleLogs());
    U.on(document.getElementById('btnCloseLogs'), 'click', () => toggleLogs(false));
    U.on(document.getElementById('btnClearLogs'), 'click', async () => {
      await window.cp.engine.clearLogs();
      await loadLogs();
      U.toast('日志已清空', 'ok');
    });
    U.on(document.getElementById('btnCopyBase'), 'click', () => {
      if (!APP.engine.ok) return U.toast('服务未运行', 'err');
      U.copy('http://127.0.0.1:' + APP.engine.port + '/v1', '代理地址已复制');
    });
    U.on(document.getElementById('viewActions'), 'click', (e) => {
      const btn = e.target.closest('[data-act]');
      if (!btn) return;
      const act = btn.getAttribute('data-act');
      if (act === 'refresh') { APP.refresh().then(() => renderCurrent()); return; }
      const view = window.VIEWS[APP.view];
      if (view && view.onAction) view.onAction(act, btn);
    });
    U.on(document.body, 'keydown', (e) => {
      if (e.key === 'Escape' && logsOpen) toggleLogs(false);
    });

    window.cp.onEngineState((state) => {
      const wasOk = APP.engine.ok;
      APP.engine = state;
      paintConn();
      if (wasOk !== state.ok) {
        U.toast(state.ok ? '代理服务已启动 · 端口 ' + state.port : '代理服务已停止', state.ok ? 'ok' : 'err');
        APP.refresh().then(() => renderCurrent());
      }
    });
    window.cp.onLog((entry) => {
      if (!logsOpen) return;
      const list = document.getElementById('logList');
      list.insertAdjacentHTML('beforeend', logRow(entry));
      while (list.children.length > 500) list.removeChild(list.firstChild);
      list.scrollTop = list.scrollHeight;
    });

    await APP.refresh();
    // 界面语言：设置里存过就用它，否则跟随系统。必须在 nav 之前定下来，
    // 否则首屏会先中文再闪成英文。
    // 用 configure（而非 setMode）—— setMode 会 location.reload()，在启动路径上就是死循环。
    if (window.I18N) {
      window.I18N.configure((APP.boot.settings && APP.boot.settings.language) || 'auto');
      window.I18N.boot();
    }
    // 自绘���题栏要让开系统窗口控件：macOS 让左侧红绿灯，Windows/Linux 让右侧叠加按钮
    document.body.setAttribute('data-platform', APP.boot.platform || 'win32');
    const startView = (APP.boot.settings && APP.boot.settings.lastView) || 'overview';
    await nav(ORDER.includes(startView) ? startView : 'overview', { force: true });

    if (!APP.engine.ok) {
      U.toast(APP.engine.error || '代理服务未运行，请到「设置」里启动', 'err');
    }
  }

  // 品牌标记（内联 SVG，避免额外资源与 CSP 例外）
  const BRAND = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
    '<rect width="32" height="32" rx="8" fill="#3987e5"/>' +
    '<path d="M9 21.5 16 10l7 11.5" fill="none" stroke="#0e1319" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<circle cx="16" cy="24" r="2.4" fill="#0e1319"/></svg>'
  );

  APP.refresh = refresh;
  APP.nav = nav;
  APP.renderCurrent = renderCurrent;
  APP.toggleLogs = toggleLogs;
  window.APP = APP;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
