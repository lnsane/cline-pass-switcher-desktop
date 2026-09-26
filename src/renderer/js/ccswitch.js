// 导入到 CC Switch —— 把本机代理做成一条 ccswitch:// 深链接，交给 cc-switch 自己去落盘。
//
// 为什么走深链接而不是直接改它的数据库：cc-switch v3 起供应商存在 SQLite 里，一次「导入」
// 要同时做四件事——新增 providers 行、写 live 配置、切换当前供应商、保存用量脚本——这几步
// 由它自己的 ProviderService 保证一致。外部改库等于绕过这一整套，早晚会写歪。
//
// 深链接格式（cc-switch v3.x，ccswitch://v1/import）：
//   resource=provider&app=claude&name=&endpoint=&apiKey=        ← endpoint/apiKey 必填
//   model → ANTHROPIC_MODEL；haikuModel/sonnetModel/opusModel → 三个别名
//   config=<base64url(JSON)> 里的 env 与上面的字段合并，URL 参数优先（非标准变量靠它带进去）
//   usageScript=<base64url(JS)> + usageEnabled=true + usageApiKey/usageBaseUrl + usageAutoInterval
(function () {
  'use strict';

  // base64url 无填充：URL 里不会出现 + / =，外面再套 encodeURIComponent 也不会被改写
  function b64url(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function query(params) {
    return Object.keys(params)
      .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== '')
      .map((k) => k + '=' + encodeURIComponent(String(params[k])))
      .join('&');
  }

  // cc-switch 的用量脚本契约：{ request: {url, method, headers}, extractor(response) }
  // {{apiKey}} / {{baseUrl}} 由 cc-switch 注入（脚本里显式给了就用脚本的值，否则用供应商自己的）。
  // 这里的 apiKey 必须是 Cline Pass 账号的 key，不是本机代理密钥——额度接口认的是上游账号。
  const USAGE_SCRIPT = [
    '({',
    '  request: {',
    '    url: "{{baseUrl}}/v1/users/me/plan/usage-limits",',
    '    method: "GET",',
    '    headers: {',
    '      accept: "*/*",',
    '      Authorization: "Bearer {{apiKey}}",',
    '      "User-Agent": "cc-switch/1.0",',
    '    },',
    '  },',
    '  extractor: function (response) {',
    '    var WINDOWS = [',
    '      { key: "five_hour", label: "5小时" },',
    '      { key: "weekly", label: "本周" },',
    '      { key: "monthly", label: "本月" },',
    '    ];',
    '',
    '    var body = response;',
    '    if (typeof body === "string") {',
    '      try { body = JSON.parse(body); } catch (e) { body = null; }',
    '    }',
    '    if (!body || typeof body !== "object") {',
    '      return { isValid: false, invalidMessage: "响应无法解析" };',
    '    }',
    '',
    '    var data = body.data || body;',
    '    var limits = data && data.limits;',
    '',
    '    if (body.success === false || !Array.isArray(limits)) {',
    '      return {',
    '        isValid: false,',
    '        invalidMessage: body.error || body.message || "套餐不可用或凭证已失效",',
    '      };',
    '    }',
    '    if (limits.length === 0) {',
    '      return { isValid: false, invalidMessage: "未返回额度信息" };',
    '    }',
    '',
    '    var byType = {};',
    '    for (var i = 0; i < limits.length; i++) {',
    '      var item = limits[i];',
    '      var pct = Number(item && item.percentUsed);',
    '      if (!item || !item.type || isNaN(pct)) continue;',
    '      byType[item.type] = { pct: pct, resetsAt: item.resetsAt };',
    '    }',
    '',
    '    var order = [];',
    '    for (var w = 0; w < WINDOWS.length; w++) {',
    '      if (byType[WINDOWS[w].key]) order.push(WINDOWS[w].key);',
    '    }',
    '    for (var t in byType) {',
    '      if (order.indexOf(t) === -1) order.push(t);',
    '    }',
    '    if (order.length === 0) {',
    '      return { isValid: false, invalidMessage: "额度字段格式异常" };',
    '    }',
    '',
    '    function label(key) {',
    '      for (var w = 0; w < WINDOWS.length; w++) {',
    '        if (WINDOWS[w].key === key) return WINDOWS[w].label;',
    '      }',
    '      return key;',
    '    }',
    '    function countdown(iso) {',
    '      var ms = Date.parse(iso) - Date.now();',
    '      if (isNaN(ms) || ms <= 0) return "";',
    '      var mins = Math.floor(ms / 60000);',
    '      var days = Math.floor(mins / 1440);',
    '      var hours = Math.floor((mins % 1440) / 60);',
    '      mins = mins % 60;',
    '      if (days > 0) return days + "天" + hours + "小时后重置";',
    '      if (hours > 0) return hours + "小时" + mins + "分后重置";',
    '      return mins + "分钟后重置";',
    '    }',
    '',
    '    // 以最紧张的窗口作为剩余额度口径',
    '    var worstKey = order[0];',
    '    for (var o = 1; o < order.length; o++) {',
    '      if (byType[order[o]].pct > byType[worstKey].pct) worstKey = order[o];',
    '    }',
    '',
    '    var parts = [];',
    '    for (var p = 0; p < order.length; p++) {',
    '      var k = order[p];',
    '      var cd = countdown(byType[k].resetsAt);',
    '      parts.push(label(k) + "已用 " + byType[k].pct + "%" + (cd ? "，" + cd : ""));',
    '    }',
    '',
    '    var used = Math.round(byType[worstKey].pct * 100) / 100;',
    '    return {',
    '      isValid: true,',
    '      planName: "Cline Pass",',
    '      unit: "%",',
    '      total: 100,',
    '      used: used,',
    '      remaining: Math.max(0, Math.round((100 - used) * 100) / 100),',
    '      extra: parts.join(" | "),',
    '    };',
    '  },',
    '})',
  ].join('\n');

  // 默认模型：本机代理的模型映射默认全走这一个（Opus/Sonnet/Haiku/Fable/子代理五个位置）
  const DEFAULT_MODEL = 'cline-pass/deepseek-v4.1-flash';
  function pickDefaultModel(models) {
    if (!models.length) return DEFAULT_MODEL;
    return models.indexOf(DEFAULT_MODEL) >= 0 ? DEFAULT_MODEL : models[0];
  }

  // 本机代理同时说两种协议：/v1/messages（Anthropic）与 /v1/chat/completions（OpenAI Chat）。
  // 所以 cc-switch 那边「上游格式」选哪个都能用，只是链路不同：
  //   Anthropic（默认）→ Claude Code 直连代理，不需要 cc-switch 的本地路由；
  //   OpenAI Chat    → cc-switch 先把 Anthropic 转成 Chat 再转过来，它的本地路由必须开着。
  // 这个字段不在 ccswitch:// 的参数表里（见 cc-switch 的 DeepLinkImportRequest），
  // 深链接带不过去，所以写进备注提醒，并在弹窗里说明。
  const FORMAT_NOTE = '本机代理支持 Anthropic / OpenAI Chat 两种格式';

  // 上游额度接口的根地址：config.upstreamBase 形如 https://api.cline.bot/api/v1，去掉 /v1
  function upstreamBase() {
    const raw = (window.APP.boot && window.APP.boot.config && window.APP.boot.config.upstreamBase) || 'https://api.cline.bot/api/v1';
    try {
      const u = new URL(raw);
      let p = u.pathname.replace(/\/+$/, '');
      if (p.endsWith('/v1')) p = p.slice(0, -3);
      return u.origin + p;
    } catch {
      return 'https://api.cline.bot/api';
    }
  }

  function localBase() {
    const b = (window.APP.boot && window.APP.boot.proxyBase) || '';
    if (b) return b.replace(/\/+$/, '');
    return 'http://127.0.0.1:' + ((window.APP.engine && window.APP.engine.port) || '') + '/v1';
  }

  function buildLink(o) {
    const p = {
      resource: 'provider',
      app: 'claude',
      name: o.name,
      endpoint: o.baseUrl,
      homepage: o.baseUrl,
      apiKey: o.apiKey,
      model: o.model,
      haikuModel: o.model,
      sonnetModel: o.model,
      opusModel: o.model,
      notes: o.notes,
      enabled: o.enabled ? 'true' : 'false',
    };
    if (o.extraEnv && Object.keys(o.extraEnv).length) {
      p.config = b64url(JSON.stringify({ env: o.extraEnv }));
      p.configFormat = 'json';
    }
    if (o.usageKey) {
      p.usageEnabled = 'true';
      p.usageScript = b64url(USAGE_SCRIPT);
      p.usageApiKey = o.usageKey;
      p.usageBaseUrl = o.usageBaseUrl;
      p.usageAutoInterval = '5';
    }
    return 'ccswitch://v1/import?' + query(p);
  }

  // 手动粘贴用：cc-switch 里「添加供应商」的配置就是这个形状（等价于上面 config 字段的内容）
  function buildSettingsConfig(o) {
    const env = Object.assign({}, o.extraEnv || {});
    env.ANTHROPIC_BASE_URL = o.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = o.apiKey;
    env.ANTHROPIC_MODEL = o.model;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = o.model;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = o.model;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = o.model;
    return JSON.stringify({ env: env }, null, 2);
  }

  // ---------- 弹窗 ----------
  function open() {
    const engine = window.APP.engine || {};
    if (!engine.ok) { U.toast('代理服务未运行：先在「设置」里启动服务，再来导入', 'err'); return; }

    const cfg = (window.APP.boot && window.APP.boot.config) || {};
    const proxyKey = cfg.proxyKey || '';
    // cc-switch 要求 apiKey 非空；本机代理免鉴权时给一个明摆着的占位符，免得导入被它挡回来
    const apiKey = proxyKey || 'local-proxy-no-key';
    const publicBase = String(cfg.publicBaseUrl || '').trim().replace(/\/+$/, '');
    const baseChoices = [{ label: '本机 · ' + localBase(), value: localBase() }];
    if (publicBase) baseChoices.push({ label: '公网 · ' + publicBase, value: publicBase });

    const models = (window.APP.models || []).map((m) => m.id);
    if (!models.length) models.push(DEFAULT_MODEL);

    const accounts = (window.APP.accounts || []).filter((a) => a.enabled !== false && a.key);
    const usageKey = accounts.length ? accounts[0].key : '';

    const state = {
      baseUrl: baseChoices[0].value,
      model: pickDefaultModel(models),
      withUsage: !!usageKey,
      withEnv: true,
      activate: true,
    };

    function extraEnv() {
      if (!state.withEnv) return {};
      return {
        ANTHROPIC_DEFAULT_FABLE_MODEL: state.model,
        CLAUDE_CODE_SUBAGENT_MODEL: state.model,
      };
    }

    function link() {
      return buildLink({
        name: (U.$('#ccName') && U.$('#ccName').value.trim()) || 'Cline Pass',
        baseUrl: state.baseUrl,
        apiKey: apiKey,
        model: state.model,
        notes: '由 Cline Pass Switcher 生成 · ' + state.baseUrl + ' · ' + FORMAT_NOTE,
        enabled: state.activate,
        extraEnv: extraEnv(),
        usageKey: state.withUsage ? usageKey : '',
        usageBaseUrl: upstreamBase(),
      });
    }

    const body = [
      !proxyKey
        ? '<div class="banner b-warning" style="margin-bottom:14px"><span class="b-ico">⚠</span><div>' +
            '本机代理没有设密钥（免鉴权）。cc-switch 要求 API Key 非空，导入时会填占位符 ' +
            '<span class="mono">local-proxy-no-key</span>——代理不校验它，能用。' +
            '想要真密钥就到「设置 → 访问与安全」生成一个。</div></div>'
        : '',
      '<div class="banner" style="margin-bottom:14px"><span class="b-ico">ⓘ</span><div>' +
        '本机代理同时支持 <span class="mono">/v1/messages</span>（Anthropic）与 ' +
        '<span class="mono">/v1/chat/completions</span>（OpenAI Chat），' +
        '所以 cc-switch 里这条供应商的<b>上游格式</b>选哪个都能用：留默认的 ' +
        '<span class="mono">Anthropic</span> 就是 Claude Code 直连代理，不需要本地路由；' +
        '选 <span class="mono">OpenAI Chat Completions</span> 则由 cc-switch 先转成 Chat 再转过来，' +
        '这时它的<b>本地路由</b>要开着。</div></div>' +
      '<div class="grid-2">',
        '<div class="field"><label class="field-label">供应商名称</label>' +
          '<input class="input" id="ccName" value="Cline Pass" spellcheck="false"></div>',
        '<div class="field"><label class="field-label">代理地址</label>' +
          '<select class="select" id="ccBase">' +
            baseChoices.map((c) => '<option value="' + U.esc(c.value) + '">' + U.esc(c.label) + '</option>').join('') +
          '</select></div>',
      '</div>',
      '<div class="field"><label class="field-label">默认模型（同时作为 Haiku / Sonnet / Opus 三个别名）</label>' +
        '<select class="select" id="ccModel">' +
          models.map((m) => '<option value="' + U.esc(m) + '"' + (m === state.model ? ' selected' : '') + '>' + U.esc(m) + '</option>').join('') +
        '</select>' +
        '<div class="field-hint">三个别名指向同一个模型：Claude Code 里切 Opus / Sonnet / Haiku 都走这条上游，不会去连 Anthropic 官方。</div></div>',

      '<label class="switch"><input type="checkbox" id="ccUsage"' + (state.withUsage ? ' checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">一并导入用量查询脚本</span></label>' +
      '<div class="field-hint" style="margin:-2px 0 10px 34px">' +
        (usageKey
          ? '用第一个启用账号（' + U.esc(accounts[0].name) + '）的 key 读 Cline 官方额度；导入后 cc-switch 里能直接看到 5 小时 / 本周 / 本月余量。'
          : '<span class="muted">账号池为空，带不了用量脚本——先到「账号池」加一个 Cline Pass 账号。</span>') +
      '</div>',

      '<label class="switch"><input type="checkbox" id="ccEnv"' + (state.withEnv ? ' checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">额外写入 Claude Code 环境变量</span></label>' +
      '<div class="field-hint" style="margin:-2px 0 10px 34px">' +
        'ANTHROPIC_DEFAULT_FABLE_MODEL 与 CLAUDE_CODE_SUBAGENT_MODEL 都指向上面这个模型：Fable 与子代理不会漏回 Anthropic 官方。</div>',

      '<label class="switch"><input type="checkbox" id="ccActivate"' + (state.activate ? ' checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">导入后立即切换为当前供应商</span></label>',

      '<div class="field" style="margin-top:14px"><label class="field-label">ccswitch:// 深链接（改写 Claude Code 的 ~/.claude/settings.json 由 cc-switch 完成）</label>' +
        '<textarea class="textarea" id="ccLink" rows="4" readonly wrap="off" style="white-space:pre;overflow-x:auto"></textarea></div>',
    ].join('');

    const m = U.modal({
      title: '导入到 CC Switch',
      bodyHTML: body,
      width: 760,
      confirmLabel: '一键导入到 CC Switch',
      cancelLabel: '关闭',
      onConfirm: () => doImport(),
    });

    const root = m.root;
    const linkBox = U.$('#ccLink', root);

    function sync() {
      linkBox.value = link();
      const usageBox = U.$('#ccUsage', root);
      if (usageBox && !usageKey) { usageBox.checked = false; usageBox.disabled = true; state.withUsage = false; }
    }

    U.delegate(root, 'input', '#ccName', () => sync());
    U.delegate(root, 'change', '#ccBase', (_e, el) => { state.baseUrl = el.value; sync(); });
    U.delegate(root, 'change', '#ccModel', (_e, el) => { state.model = el.value; sync(); });
    U.delegate(root, 'change', '#ccUsage', (_e, el) => { state.withUsage = el.checked; sync(); });
    U.delegate(root, 'change', '#ccEnv', (_e, el) => { state.withEnv = el.checked; sync(); });
    U.delegate(root, 'change', '#ccActivate', (_e, el) => { state.activate = el.checked; sync(); });
    U.delegate(root, 'click', '[data-copy-link]', () => U.copy(linkBox.value, '深链接已复制'));
    U.delegate(root, 'click', '[data-copy-json]', () => U.copy(buildSettingsConfig({
      baseUrl: state.baseUrl, apiKey: apiKey, model: state.model, extraEnv: extraEnv(),
    }), '配置 JSON 已复制'));

    // 手动粘贴的兜底入口放在弹窗底部左侧
    const foot = U.$('.modal-foot', root);
    if (foot) {
      foot.insertAdjacentHTML('afterbegin',
        '<button class="btn btn-ghost" data-copy-link style="margin-right:auto">复制深链接</button>' +
        '<button class="btn btn-ghost" data-copy-json style="margin-right:8px">复制配置 JSON</button>');
    }

    sync();

    async function doImport() {
      const url = linkBox.value;
      let info = { hasConfigDir: false, hasApp: false };
      try { info = await window.cp.ccswitch.detect(); } catch { /* 探测失败不拦路 */ }
      try {
        const r = await window.cp.ccswitch.open(url);
        if (!r || !r.ok) throw new Error((r && r.error) || '打开失败');
      } catch (e) {
        await U.copy(url, '无法唤起 cc-switch，深链接已复制');
        U.toast('唤起失败：' + e.message, 'err');
        return false; // 留住弹窗，链接还在用户手上
      }
      U.toast(info.hasConfigDir || info.hasApp
        ? '已交给 cc-switch：确认弹窗里核对脚本后点导入'
        : '未检测到 cc-switch，已把深链接交给系统处理', info.hasConfigDir || info.hasApp ? 'ok' : 'err');
      return true;
    }
  }

  window.CCSWITCH = { open, buildLink, buildSettingsConfig, USAGE_SCRIPT };
})();