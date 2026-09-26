// 概览：运行状态、关键指标、接入信息、账号真实额度、最近请求
(function () {
  'use strict';

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    const boot = window.APP.boot;
    const engine = window.APP.engine;

    let models = null, accounts = null, history = null;
    const errors = [];
    if (engine.ok) {
      [models, accounts, history] = await Promise.all([
        API.models().catch((e) => { errors.push('模型列表：' + e.message); return null; }),
        API.accounts().catch((e) => { errors.push('账号：' + e.message); return null; }),
        API.history().catch(() => null),
      ]);
    }

    const sub = (models && models.subscription) || [];
    const accs = (accounts && accounts.accounts) || [];
    const stats = (accounts && accounts.stats) || {};
    const hist = (history && history.history) || [];

    const probed = sub.filter((s) => s.meta && s.meta.pipeline);
    const upstreamTotal = sub.reduce((n, s) => n + ((s.meta && s.meta.upstreams) || []).length, 0);
    const reqTotal = Object.values(stats).reduce((n, s) => n + (Number(s.requests) || 0), 0);
    const latencies = hist.map((h) => Number(h.ms)).filter((n) => isFinite(n) && n > 0);
    const avgMs = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;

    root.innerHTML = [
      renderBanners(engine, accs, errors),
      renderKpis({ engine, config: boot.config, accs, sub, probed, upstreamTotal, reqTotal, avgMs }),
      renderEndpoint(boot),
      renderQuotaCard(accs),
      renderRecent(hist),
    ].join('');

    wire(root, boot);
    if (accs.length && engine.ok) loadQuotas(root, accs);
  }

  function renderBanners(engine, accs, errors) {
    const out = [];
    if (!engine.ok) {
      out.push('<div class="banner b-critical"><span class="b-ico">⚠</span><div>' +
        '<strong>代理服务未运行</strong><br>' + U.esc(engine.error || '引擎尚未启动') +
        '　<a href="#" data-act="goto-settings" style="color:var(--series-1)">前往设置</a></div></div>');
    }
    if (!accs.length) {
      out.push('<div class="banner b-warning"><span class="b-ico">⚠</span><div>' +
        '<strong>还没有配置账号</strong><br>添加一个 Cline Pass API Key（<span class="mono">sk_</span> 开头）后，代理才能向上游转发请求。' +
        '　<a href="#" data-act="goto-accounts" style="color:var(--series-1)">去添加</a></div></div>');
    }
    for (const e of errors) {
      out.push('<div class="banner b-critical"><span class="b-ico">⚠</span><div>' + U.esc(e) + '</div></div>');
    }
    return out.join('');
  }

  function renderKpis(d) {
    const running = d.engine.ok;
    return '<div class="kpi-row">' +
      tile('代理服务', running ? '运行中' : '已停止', running ? 'is-good' : 'is-bad',
           running ? '127.0.0.1:' + d.engine.port : (d.engine.error ? '启动失败' : '未启动')) +
      tile('账号', U.fmtInt(d.accs.length), '', d.accs.filter((a) => a.enabled !== false).length + ' 个已启用') +
      tile('订阅模型', U.fmtInt(d.sub.length), '', d.probed.length + ' 个已探测管道') +
      tile('已知渠道', U.fmtInt(d.upstreamTotal), '', '全部订阅模型合计') +
      tile('代理请求', U.fmtInt(d.reqTotal), '', '本次运行累计') +
      tile('平均延迟', d.avgMs ? U.fmtMs(d.avgMs) : '—', '', d.avgMs ? '最近 ' + Math.min(100, d.avgMs ? 100 : 0) + ' 条以内样本' : '暂无成功请求') +
    '</div>';
  }

  function tile(label, value, cls, sub) {
    return '<div class="stat-tile"><div class="stat-label">' + U.esc(label) + '</div>' +
      '<div class="stat-value ' + (cls || '') + '">' + U.esc(value) + '</div>' +
      '<div class="stat-sub">' + U.esc(sub || '') + '</div></div>';
  }

  function renderEndpoint(boot) {
    const base = window.APP.engine.ok ? (boot.proxyBase || '') : '';
    // Claude Code 走 Anthropic Messages：给根地址（去掉结尾的 /v1）。带 /v1 的写法代理也认。
    const anthBase = base ? base.replace(/\/+$/, '').replace(/\/v1$/, '') : '';
    const proxyKey = (boot.config && boot.config.proxyKey) || '';
    const model = (window.APP.models && window.APP.models.subscription && window.APP.models.subscription[0])
      ? window.APP.models.subscription[0].id : 'cline-pass/glm-5.3-flash';
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">客户端接入</div>' +
        '<div class="card-note">OpenAI 客户端用 Base URL；Claude Code 用 ANTHROPIC_BASE_URL（代理自己把 Anthropic 翻成 Chat）</div></div>' +
      U.kv('Base URL', '<span class="mono">' + U.esc(base || '（服务未运行）') + '</span>' +
        (base ? ' <button class="btn btn-ghost btn-sm" data-copy="' + U.esc(base) + '">复制</button>' : '')) +
      U.kv('Claude Code', anthBase
        ? '<span class="mono">ANTHROPIC_BASE_URL=' + U.esc(anthBase) + '</span> <button class="btn btn-ghost btn-sm" data-copy="' + U.esc(anthBase) + '">复制</button>'
        : '<span class="muted">（服务未运行）</span>') +
      U.kv('API Key', proxyKey
        ? '<span class="mono">' + U.esc(U.maskKey(proxyKey)) + '</span> <button class="btn btn-ghost btn-sm" data-copy="' + U.esc(proxyKey) + '">复制</button>'
        : '<span class="muted">未设置（本地免鉴权）</span>') +
      U.kv('模型示例', '<span class="mono">' + U.esc(model) + '</span> <button class="btn btn-ghost btn-sm" data-copy="' + U.esc(model) + '">复制</button>') +
      (window.APP.engine.ok ? '<div class="row-gap" style="margin-top:10px">' +
        '<button class="btn btn-sm btn-primary" data-act="ccswitch">导入到 CC Switch</button>' +
        '<button class="btn btn-sm" data-act="claudecfg">写入 Claude Code 配置</button>' +
        '<button class="btn btn-sm" data-act="open-proxy-page">打开代理端口首页</button>' +
        '<button class="btn btn-sm" data-act="goto-models">配置上游钉住</button>' +
      '</div>' : '') +
    '</div>';
  }

  function renderQuotaCard(accs) {
    if (!accs.length) return '';
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">账号额度</div>' +
        '<div class="card-note">Cline Pass 官方用量窗口（5 小时 / 本周 / 本月）' +
        ' <button class="btn btn-ghost btn-sm" data-act="reload-quota">刷新</button></div></div>' +
      '<div id="quotaBody"><div class="empty">读取中…</div></div>' +
    '</div>';
  }

  async function loadQuotas(root, accs) {
    const body = U.$('#quotaBody', root);
    if (!body) return;
    const rows = await Promise.all(accs.map(async (a) => {
      if (a.enabled === false) return { name: a.name, skipped: true };
      try {
        const r = await window.cp.quota.fetch(a.key);
        return { name: a.name, ...r };
      } catch (e) {
        return { name: a.name, ok: false, error: e.message };
      }
    }));
    body.innerHTML = rows.map(renderQuotaRow).join('');
  }

  const WINDOW_LABEL = { five_hour: '5 小时', weekly: '本周', monthly: '本月' };

  function renderQuotaRow(r) {
    let inner;
    if (r.skipped) {
      inner = '<span class="muted">已停用</span>';
    } else if (!r.ok) {
      inner = '<span class="badge b-serious"><span class="b-ico">⚿</span>读取失败</span> <span class="muted">' + U.esc(r.error || '') + '</span>';
    } else {
      const byType = {};
      for (const it of r.limits || []) byType[it.type] = it;
      const order = ['five_hour', 'weekly', 'monthly'].filter((k) => byType[k]);
      inner = order.map((k) => {
        const it = byType[k];
        const pct = Number(it.percentUsed) || 0;
        return U.meter(pct, WINDOW_LABEL[k] || k, resetText(it.resetsAt));
      }).join('');
    }
    return '<div style="padding:9px 0;border-bottom:1px solid var(--hairline-soft)">' +
      '<div class="inline" style="margin-bottom:2px"><strong style="font-size:12.5px">' + U.esc(r.name) + '</strong></div>' +
      inner + '</div>';
  }

  function resetText(iso) {
    const ms = Date.parse(iso) - Date.now();
    if (!isFinite(ms) || ms <= 0) return '';
    const mins = Math.floor(ms / 60000);
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = mins % 60;
    if (d > 0) return d + ' 天 ' + h + ' 小时后重置';
    if (h > 0) return h + ' 小时 ' + m + ' 分后重置';
    return m + ' 分钟后重置';
  }

  function renderRecent(hist) {
    if (!hist.length) return '';
    const rows = hist.slice(0, 5).map((h) => '<tr>' +
      '<td class="muted">' + U.fmtTime(h.ts) + '</td>' +
      '<td class="mono ellip" title="' + U.esc(h.model) + '">' + U.esc(h.model) + '</td>' +
      '<td>' + (h.provider ? '<span class="mono">' + U.esc(h.provider) + '</span>' : '<span class="muted">—</span>') + '</td>' +
      '<td>' + U.latCell(h.ms) + '</td>' +
      '<td>' + (h.error
        ? U.statusBadge('bad', '失败')
        : U.statusBadge('ok', '成功')) + '</td>' +
    '</tr>').join('');
    return '<div class="card tight"><div class="card-head"><div class="card-title">最近请求</div>' +
      '<button class="btn btn-ghost btn-sm" data-act="goto-history">全部记录</button></div>' +
      '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>时间</th><th>模型</th><th>实际渠道</th><th>耗时</th><th>结果</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div></div>';
  }

  function wire(root, boot) {
    U.delegate(root, 'click', '[data-copy]', (_e, el) => U.copy(el.getAttribute('data-copy')));
    U.delegate(root, 'click', '[data-act]', (e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'goto-accounts') { e.preventDefault(); window.APP.nav('accounts'); }
      else if (act === 'goto-settings') { e.preventDefault(); window.APP.nav('settings'); }
      else if (act === 'goto-models') { window.APP.nav('models'); }
      else if (act === 'goto-history') { window.APP.nav('history'); }
      else if (act === 'open-proxy-page') { window.cp.app.openExternal('http://127.0.0.1:' + window.APP.engine.port + '/'); }
      else if (act === 'ccswitch') { window.CCSWITCH.open(); }
      else if (act === 'claudecfg') { window.CLAUDECFG.open(); }
      else if (act === 'reload-quota') {
        const body = U.$('#quotaBody', root);
        if (body) { body.innerHTML = '<div class="empty">读取中…</div>'; loadQuotas(root, window.APP.accounts); }
      }
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.overview = {
    title: '概览',
    sub: () => '代理运行状态、接入信息与账号额度',
    actions: () => '<button class="btn btn-sm" data-act="refresh">刷新</button>',
    async load(root) { await load(root); },
    async onAction(act) {
      if (act === 'refresh') { await window.APP.refresh(); window.APP.renderCurrent(); }
    },
  };
})();
