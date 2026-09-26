// 与内嵌引擎（127.0.0.1:port）通讯。引擎同时充当代理与配置 API，桌面端直接复用它的 /api/*。
(function () {
  'use strict';

  const API = {
    port: null,
    proxyKey: '',
    base: '',

    applyBootstrap(b) {
      this.port = b && b.engine && b.engine.ok ? b.engine.port : (b && b.config ? b.config.port : null);
      this.proxyKey = (b && b.config && b.config.proxyKey) || '';
      this.base = this.port ? 'http://127.0.0.1:' + this.port : '';
      return this;
    },

    setPort(port) {
      this.port = Number(port) || null;
      this.base = this.port ? 'http://127.0.0.1:' + this.port : '';
    },

    setProxyKey(k) { this.proxyKey = k || ''; },

    // 引擎未启动 / 正在重启时的统一报错
    _offline() {
      const e = new Error('引擎未在运行，请到「设置」里启动服务');
      e.offline = true;
      return e;
    },

    async req(path, { method = 'GET', body, timeoutMs = 190000 } = {}) {
      if (!this.base) throw this._offline();
      const headers = { Accept: 'application/json' };
      if (this.proxyKey) headers['X-Admin-Key'] = this.proxyKey;
      if (body !== undefined) headers['Content-Type'] = 'application/json';

      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try {
        res = await fetch(this.base + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (this.proxyKey && /Failed to fetch|NetworkError/i.test(e.message)) {
          // 端口通但被引擎拒绝时 fetch 不会抛错，这里只可能是进程没起或端口变了
          throw this._offline();
        }
        throw new Error(e.name === 'AbortError' ? '请求超时' : ('无法连接引擎：' + e.message));
      } finally {
        clearTimeout(timer);
      }

      let json = null;
      const text = await res.text();
      try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
      if (!res.ok) {
        const msg = json && json.error
          ? (typeof json.error === 'string' ? json.error : json.error.message || JSON.stringify(json.error))
          : ('HTTP ' + res.status);
        const err = new Error(msg);
        err.status = res.status;
        err.payload = json;
        throw err;
      }
      return json;
    },

    // ---------- 引擎接口 ----------
    meta:            () => API.req('/api/meta'),
    models:          () => API.req('/api/models'),
    probe:           (model) => API.req('/api/probe', { method: 'POST', body: { model } }),
    test:            (payload) => API.req('/api/test', { method: 'POST', body: payload }),
    accounts:        () => API.req('/api/accounts'),
    saveAccounts:    (payload) => API.req('/api/accounts', { method: 'POST', body: payload }),
    testAccount:     (key) => API.req('/api/accounts/test', { method: 'POST', body: { key } }),
    security:        () => API.req('/api/security'),
    saveSecurity:    (payload) => API.req('/api/security', { method: 'POST', body: payload }),
    validateUpstreams: (model) => API.req('/api/validate-upstreams', { method: 'POST', body: { model } }),
    fetchOfficial:   () => API.req('/api/fetch-official-models', { method: 'POST', body: {} }),
    history:         () => API.req('/api/history'),
    config:          () => API.req('/api/config'),
    savePerModel:    (perModel) => API.req('/api/config', { method: 'POST', body: { perModel } }),

    // ---------- 用量统计 ----------
    // 汇总：granularity='hour' 时按小时返回（「当天」这一档画 0-23 点曲线用）
    usage: (days, granularity) => API.req('/api/usage?days=' + encodeURIComponent(days || 30) +
      (granularity ? '&granularity=' + encodeURIComponent(granularity) : '')),
    // 明细：引擎按写入序号倒序取，再按时间倒序返回（最新的在前）
    usageRecords: (opts = {}) => {
      const q = new URLSearchParams();
      if (opts.limit) q.set('limit', opts.limit);
      if (opts.model) q.set('model', opts.model);
      if (opts.source) q.set('source', opts.source);
      if (opts.from) q.set('from', opts.from);
      if (opts.to) q.set('to', opts.to);
      const s = q.toString();
      return API.req('/api/usage/records' + (s ? '?' + s : ''));
    },
    // 扫描 Claude Code 会话记录（不开代理也能统计）。慢，给足超时。
    usageScan:    (opts = {}) => API.req('/api/usage/scan', { method: 'POST', body: opts, timeoutMs: 300000 }),
    usagePricing: () => API.req('/api/usage/pricing'),
    // DeepSeek 官方人民币价目表 + 当前处于高峰/空闲
    usagePricingCny: () => API.req('/api/usage/pricing-cny'),
    savePricing:  (pricing) => API.req('/api/usage/pricing', { method: 'POST', body: { pricing } }),
    usageCompact: (keepDays) => API.req('/api/usage/compact', { method: 'POST', body: { keepDays }, timeoutMs: 120000 }),
    // 重算汇总与逐条的人民币金额（给加入人民币计价之前的老数据补上）
    usageRecompute: () => API.req('/api/usage/recompute', { method: 'POST', body: {}, timeoutMs: 300000 }),
    // 花费口径（只影响展示，不改记录）
    saveUsageCurrency: (usageCurrency) => API.req('/api/config', { method: 'POST', body: { usageCurrency } }),

    // 修改单个模型的钉住配置（引擎按整表覆盖，所以先取全表再改一项）
    async patchPerModel(modelId, patch) {
      const cur = await API.config();
      const perModel = Object.assign({}, cur.perModel || {});
      perModel[modelId] = Object.assign({ upstreams: [], exclude: [], pinMode: 'strict', sort: null }, perModel[modelId] || {}, patch);
      await API.savePerModel(perModel);
      return perModel[modelId];
    },
  };

  window.API = API;
})();
