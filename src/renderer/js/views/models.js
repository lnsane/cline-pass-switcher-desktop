// 订阅模型：管道识别、上游渠道枚举、有序钉住链、探测 / 测试 / 全渠道校验
(function () {
  'use strict';

  let models = [];       // /api/models 的 subscription
  let perModel = {};     // /api/config 的 perModel
  let busy = {};         // modelId -> 正在进行的动作名
  let onlyProbed = false;

  async function fetchAll() {
    const [m, c] = await Promise.all([API.models(), API.config()]);
    models = m.subscription || [];
    perModel = c.perModel || {};
    return { meta: m, cfg: c };
  }

  function cfgOf(id) {
    return Object.assign({ upstreams: [], exclude: [], pinMode: 'strict', sort: null }, perModel[id] || {});
  }

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await fetchAll();
    } catch (e) {
      root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>读取失败：' + U.esc(e.message) + '</div></div>';
      return;
    }
    render(root);
  }

  function render(root) {
    const list = onlyProbed ? models.filter((m) => m.meta && m.meta.pipeline) : models;
    root.innerHTML = [
      renderToolbar(),
      renderTable(list),
      renderLegend(),
    ].join('');
  }

  function renderToolbar() {
    return '<div class="card tight"><div class="row-gap">' +
      '<label class="switch"><input type="checkbox" data-act="only-probed" ' + (onlyProbed ? 'checked' : '') + '><span class="track"></span><span class="switch-label">只看已探测</span></label>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm" data-act="probe-all">探测全部</button>' +
      '<button class="btn btn-sm" data-act="validate-all">校验全部渠道</button>' +
      '<button class="btn btn-sm" data-act="fetch-official">拉取官方最新模型</button>' +
      '</div>' +
      '<div class="card-note" style="margin-top:8px">探测：识别模型走哪条管道并枚举可用渠道（极小额真实请求）。校验：把每个渠道各钉一次，实测可用性（渠道多时耗时较久）。</div>' +
    '</div>';
  }

  function renderTable(list) {
    if (!list.length) return U.empty('没有模型');
    const rows = list.map((m) => {
      const meta = m.meta || {};
      const cfg = cfgOf(m.id);
      const ups = meta.upstreams || [];
      const status = meta.upstreamStatus || {};
      const busyName = busy[m.id];
      const actual = meta.provider || meta.lastProvider;
      const latMs = meta.ms || meta.lastMs;

      return '<tr data-model="' + U.esc(m.id) + '">' +
        '<td><div class="mono ellip" title="' + U.esc(m.id) + '">' + U.esc(m.id) + '</div>' +
          (meta.canonicalSlug ? '<div class="muted mono" style="font-size:11px">↳ ' + U.esc(meta.canonicalSlug) + '</div>' : '') + '</td>' +
        '<td>' + U.pipelineBadge(meta.pipeline) + '</td>' +
        '<td>' + renderChain(cfg, ups) + '</td>' +
        '<td>' + (actual
            ? '<span class="mono ellip-block" title="' + U.esc(actual) + '">' + U.esc(actual) + '</span>'
            : '<span class="muted">—</span>') +
          (latMs ? '<div class="muted" style="font-size:11px">' + U.fmtMs(latMs) + '</div>' : '') + '</td>' +
        '<td>' + U.esc(U.pinModeLabel(cfg.pinMode)) + (cfg.sort ? '<div class="muted" style="font-size:11px">' + U.esc(U.sortLabel(cfg.sort)) + '</div>' : '') + '</td>' +
        '<td><div class="row-gap tight">' +
          '<button class="btn btn-sm" data-act="chain" ' + (ups.length ? '' : 'disabled title="先探测以获取渠道清单"') + '>渠道' + (ups.length ? ' (' + ups.length + ')' : '') + '</button>' +
          '<button class="btn btn-sm" data-act="probe" ' + (busyName ? 'disabled' : '') + '>' + (busyName === 'probe' ? '探测中…' : '探测') + '</button>' +
          '<button class="btn btn-sm" data-act="test" ' + (busyName ? 'disabled' : '') + '>' + (busyName === 'test' ? '测试中…' : '测试') + '</button>' +
          '<button class="btn btn-sm" data-act="validate" ' + (busyName || !ups.length ? 'disabled' : '') + '>' + (busyName === 'validate' ? '校验中…' : '校验') + '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    return '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th style="min-width:200px">模型</th><th style="width:88px">管道</th><th style="min-width:230px">钉住链（按序回退）</th>' +
      '<th style="width:150px">最近实际渠道</th><th style="width:110px">模式</th><th style="width:290px">操作</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function renderChain(cfg, ups) {
    const sel = cfg.upstreams || [];
    const exc = cfg.exclude || [];
    if (!sel.length && !exc.length) {
      return '<span class="muted">自动（网关自选）</span>';
    }
    const chips = sel.map((u, i) => '<span class="chain-slot"><span class="ord">' + (i + 1) + '</span>' + U.esc(u) + '</span>');
    const exChips = exc.map((u) => '<span class="chain-slot excluded"><span class="ord">✘</span>' + U.esc(u) + '</span>');
    return '<div class="row-gap tight">' + chips.join('<span class="chain-arrow">→</span>') +
      (exChips.length ? '<span class="chain-arrow" style="margin-left:4px">排除</span>' + exChips.join('') : '') + '</div>';
  }

  function renderLegend() {
    return '<div class="card tight"><div class="card-head"><div class="card-title">渠道状态图例</div>' +
      '<div class="card-note">校验后写入本地学习结果，钉住失败的渠道会被自动标记</div></div>' +
      '<div class="row-gap">' + U.statusBadge('ok') + U.statusBadge('limited') + U.statusBadge('bad') + U.statusBadge('auth') + U.statusBadge('unknown') + '</div></div>';
  }

  // ---------- 渠道链编辑 ----------
  function openChainEditor(modelId, root) {
    const item = models.find((m) => m.id === modelId);
    const meta = (item && item.meta) || {};
    const cfg = cfgOf(modelId);
    const all = Array.from(new Set([...(meta.upstreams || []), ...(cfg.upstreams || []), ...(cfg.exclude || [])]));
    const status = meta.upstreamStatus || {};
    let chain = (cfg.upstreams || []).slice();
    let exclude = (cfg.exclude || []).slice();
    let pinMode = cfg.pinMode || 'strict';
    let sort = cfg.sort || null;

    const bodyHTML = () =>
      '<div class="banner"><span class="b-ico">ℹ</span><div>' +
        '管道：' + (meta.pipeline === 'planner' ? '规划器（Vercel AI Gateway）→ 请求体注入 <span class="mono">providerOptions.gateway</span>' :
          meta.pipeline === 'direct' ? '直连（OpenRouter）→ 请求体注入 <span class="mono">provider</span>' : '尚未探测') +
        '<br>按顺序逐个钉住尝试：第一个异常自动顺切下一个，全部失败才把错误透传给客户端。' +
      '</div></div>' +
      '<div class="field"><label class="field-label">钉住链（勾选顺序即尝试顺序，最多 10 个）</label>' +
        '<div id="chainBox" class="row-gap tight" style="min-height:32px">' +
          (chain.length ? chain.map((u, i) =>
            '<span class="chain-slot"><span class="ord">' + (i + 1) + '</span>' + U.esc(u) +
            '<button class="x" data-chain-up="' + i + '" title="上移">↑</button>' +
            '<button class="x" data-chain-down="' + i + '" title="下移">↓</button>' +
            '<button class="x" data-chain-del="' + i + '" title="移除">✕</button></span>').join('<span class="chain-arrow">→</span>')
            : '<span class="muted">为空 = 自动（交给网关自选）</span>') +
        '</div></div>' +
      '<div class="field"><label class="field-label">排除渠道（永不被使用，优先级高于勾选）</label>' +
        '<div class="row-gap tight">' + (exclude.length
          ? exclude.map((u, i) => '<span class="chain-slot excluded"><span class="ord">✘</span>' + U.esc(u) + '<button class="x" data-ex-del="' + i + '">✕</button></span>').join('')
          : '<span class="muted">无</span>') + '</div></div>' +
      '<div class="field"><label class="field-label">可选渠道（点一下加入钉住链，Shift+点加入排除）</label>' +
        '<div class="row-gap tight">' + (all.length
          ? all.map((u) => {
              const st = status[u];
              const inChain = chain.includes(u);
              const isExc = exclude.includes(u);
              return '<button class="btn btn-sm" data-add="' + U.esc(u) + '" title="' + U.esc((st && st.note) || '') + '"' +
                (inChain || isExc ? ' disabled' : '') + '>' + U.esc(u) +
                (st ? ' ' + U.STATUS[st.status].ico : '') + '</button>';
            }).join('')
          : '<span class="muted">先点「探测」获取渠道清单</span>') +
        '</div></div>' +
      '<div class="grid-2">' +
        '<div class="field"><label class="field-label">钉住模式</label>' +
          '<select class="select" data-sel="pinMode">' +
            '<option value="strict"' + (pinMode === 'strict' ? ' selected' : '') + '>严格钉住（只用链上渠道）</option>' +
            '<option value="preferred"' + (pinMode === 'preferred' ? ' selected' : '') + '>优先+回退（链优先，可回落网关自选）</option>' +
          '</select></div>' +
        '<div class="field"><label class="field-label">排序偏好</label>' +
          '<select class="select" data-sel="sort">' +
            '<option value=""' + (!sort ? ' selected' : '') + '>网关默认</option>' +
            '<option value="cost"' + (sort === 'cost' ? ' selected' : '') + '>最低成本</option>' +
            '<option value="ttft"' + (sort === 'ttft' ? ' selected' : '') + '>最快首字</option>' +
            '<option value="tps"' + (sort === 'tps' ? ' selected' : '') + '>最高吞吐</option>' +
          '</select></div>' +
      '</div>';

    const m = U.modal({
      title: '配置上游钉住 — ' + modelId,
      width: 680,
      bodyHTML: bodyHTML(),
      confirmLabel: '保存',
      onConfirm: async (wrap) => {
        await API.patchPerModel(modelId, { upstreams: chain, exclude, pinMode, sort: sort || null });
        perModel[modelId] = Object.assign({}, cfgOf(modelId), { upstreams: chain, exclude, pinMode, sort: sort || null });
        U.toast('已保存 ' + modelId + ' 的钉住配置', 'ok');
        render(root);
      },
    });

    const wrap = m.root;
    const redraw = () => {
      U.$('.modal-body', wrap).innerHTML = bodyHTML();
      wireModal();
    };

    function wireModal() {
      U.delegate(wrap, 'click', '[data-add]', (e, el) => {
        const u = el.getAttribute('data-add');
        if (e.shiftKey) { if (!exclude.includes(u)) exclude.push(u); }
        else if (chain.length < 10 && !chain.includes(u)) chain.push(u);
        redraw();
      });
      U.delegate(wrap, 'click', '[data-chain-del]', (_e, el) => { chain.splice(Number(el.getAttribute('data-chain-del')), 1); redraw(); });
      U.delegate(wrap, 'click', '[data-chain-up]', (_e, el) => {
        const i = Number(el.getAttribute('data-chain-up'));
        if (i > 0) { const t = chain[i - 1]; chain[i - 1] = chain[i]; chain[i] = t; redraw(); }
      });
      U.delegate(wrap, 'click', '[data-chain-down]', (_e, el) => {
        const i = Number(el.getAttribute('data-chain-down'));
        if (i < chain.length - 1) { const t = chain[i + 1]; chain[i + 1] = chain[i]; chain[i] = t; redraw(); }
      });
      U.delegate(wrap, 'click', '[data-ex-del]', (_e, el) => { exclude.splice(Number(el.getAttribute('data-ex-del')), 1); redraw(); });
      U.delegate(wrap, 'change', '[data-sel]', (_e, el) => {
        const k = el.getAttribute('data-sel');
        if (k === 'pinMode') pinMode = el.value;
        if (k === 'sort') sort = el.value || null;
      });
    }
    wireModal();
  }

  // ---------- 结果展示 ----------
  function showTestResult(modelId, r) {
    const rows = [];
    rows.push(U.kv('目标链', (r.targets && r.targets.length) ? '<span class="mono">' + r.targets.map(U.esc).join(' → ') + '</span>' : '<span class="muted">自动</span>'));
    if (r.exclude && r.exclude.length) rows.push(U.kv('排除', '<span class="mono">' + r.exclude.map(U.esc).join(', ') + '</span>'));
    rows.push(U.kv('实际渠道', r.actual ? '<strong class="mono">' + U.esc(r.actual) + '</strong>' + (r.actualName && r.actualName !== r.actual ? ' <span class="muted">(' + U.esc(r.actualName) + ')</span>' : '') : '<span class="muted">—</span>'));
    rows.push(U.kv('管道', U.pipelineBadge(r.pipeline)));
    if (r.canonicalSlug) rows.push(U.kv('背后模型', '<span class="mono">' + U.esc(r.canonicalSlug) + '</span>'));
    if (r.fallbacks && r.fallbacks.length) rows.push(U.kv('可用回落', '<span class="mono">' + r.fallbacks.map(U.esc).join(', ') + '</span>'));
    rows.push(U.kv('耗时', U.esc(U.fmtMs(r.ms))));
    if (r.account) rows.push(U.kv('账号', U.esc(r.account)));
    if (r.trace && r.trace.length) rows.push(U.kv('尝试路径', U.attemptPath(r.trace)));

    const adopted = r.ok && r.targets && r.targets.length
      ? (r.targets.includes(r.actual) ? ['good', '✔ 网关采纳了钉住'] : ['serial', '⚠ 网关未采纳，实际走了 ' + (r.actual || '未知')])
      : null;

    const body = (adopted
      ? '<div class="badge ' + (adopted[0] === 'good' ? 'b-good' : 'b-serious') + '" style="margin-bottom:12px"><span class="b-ico">' + (adopted[0] === 'good' ? '✔' : '⚠') + '</span>' + U.esc(adopted[1]) + '</div>'
      : (r.ok ? '' : '<div class="badge b-critical" style="margin-bottom:12px"><span class="b-ico">✘</span>请求失败</div>')) +
      rows.join('') +
      (r.ok
        ? '<div class="field" style="margin-top:12px"><label class="field-label">模型回复</label><div class="mono" style="background:var(--surface-2);border:1px solid var(--hairline);border-radius:7px;padding:8px 10px;user-select:text">' + U.esc(r.content || '(空)') + '</div></div>'
        : '<div class="field" style="margin-top:12px"><label class="field-label">错误</label><div class="mono" style="color:var(--critical);user-select:text">' + U.esc(r.error || '') + '</div></div>');

    U.modal({ title: '测试结果 — ' + modelId, width: 620, bodyHTML: body, confirmLabel: '', cancelLabel: '关闭', onConfirm: null });
  }

  function showValidateResult(modelId, r) {
    const S = r.summary || {};
    const list = Object.entries(r.results || {})
      .sort((a, b) => (a[1].status > b[1].status ? 1 : -1))
      .map(([slug, info]) => '<tr>' +
        '<td class="mono">' + U.esc(slug) + '</td>' +
        '<td>' + U.statusBadge(info.status) + '</td>' +
        '<td>' + U.latCell(info.ms) + '</td>' +
        '<td class="muted" style="font-size:11.5px;user-select:text">' + U.esc((info.note || '').slice(0, 130)) + '</td>' +
      '</tr>').join('');

    const body =
      '<div class="row-gap" style="margin-bottom:12px">' +
        U.statusBadge('ok', '可用 ' + (S.ok || 0)) +
        U.statusBadge('limited', '限流 ' + (S.limited || 0)) +
        U.statusBadge('bad', '不可钉 ' + (S.bad || 0)) +
        U.statusBadge('auth', '密钥问题 ' + (S.auth || 0)) +
        U.statusBadge('unknown', '未知 ' + (S.unknown || 0)) +
      '</div>' +
      '<div class="banner"><span class="b-ico">ℹ</span><div>「不可钉」通常是该渠道被单独钉住时模型 ID 映射失败；「限流」是共享池临时状态，稍后重测或改用「优先+回退」即可。</div></div>' +
      '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>渠道</th><th style="width:96px">状态</th><th style="width:104px">耗时</th><th>说明</th></tr></thead>' +
      '<tbody>' + list + '</tbody></table></div></div>';

    U.modal({ title: '全渠道校验 — ' + modelId, width: 720, bodyHTML: body, confirmLabel: '', cancelLabel: '关闭', onConfirm: null });
  }

  // ---------- 动作 ----------
  async function doProbe(modelId, root) {
    busy[modelId] = 'probe'; render(root);
    try {
      const r = await API.probe(modelId);
      if (r.ok) {
        U.toast('探测完成：' + (r.pipeline === 'planner' ? '规划器' : r.pipeline === 'direct' ? '直连' : '未知管道') +
          '，' + ((r.upstreams || []).length) + ' 个渠道（' + U.fmtMs(r.ms) + '）', 'ok');
      } else {
        U.toast('探测失败：' + (r.error || '').slice(0, 160), 'err');
      }
    } catch (e) { U.toast('探测失败：' + e.message, 'err'); }
    busy[modelId] = null;
    await fetchAll().catch(() => {});
    render(root);
  }

  async function doTest(modelId, root) {
    const cfg = cfgOf(modelId);
    busy[modelId] = 'test'; render(root);
    try {
      const r = await API.test({ model: modelId, upstreams: cfg.upstreams || [], exclude: cfg.exclude || [] });
      showTestResult(modelId, r);
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('测试失败：' + e.message, 'err'); }
    busy[modelId] = null;
    render(root);
  }

  async function doValidate(modelId, root) {
    busy[modelId] = 'validate'; render(root);
    try {
      const r = await API.validateUpstreams(modelId);
      showValidateResult(modelId, r);
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('校验失败：' + e.message, 'err'); }
    busy[modelId] = null;
    render(root);
  }

  async function probeAll(root) {
    const targets = models.map((m) => m.id);
    if (!targets.length) return;
    if (!(await U.confirm('探测全部模型', '将对 ' + targets.length + ' 个模型各发一次极小额请求以识别管道与渠道清单。预计耗时 1–3 分钟，继续？', '开始探测'))) return;
    const btnState = {};
    for (const id of targets) btnState[id] = 'probe';
    busy = btnState; render(root);
    let okCount = 0;
    for (const id of targets) {
      try {
        const r = await API.probe(id);
        if (r.ok) okCount++;
      } catch { /* 单个失败不中断 */ }
      delete busy[id];
    }
    busy = {};
    U.toast('探测完成：' + okCount + '/' + targets.length + ' 成功', okCount === targets.length ? 'ok' : 'err');
    await fetchAll().catch(() => {});
    render(root);
  }

  async function validateAll(root) {
    const targets = models.filter((m) => m.meta && (m.meta.upstreams || []).length);
    if (!targets.length) return U.toast('请先探测模型以获取渠道清单', 'err');
    const total = targets.reduce((n, m) => n + (m.meta.upstreams || []).length, 0);
    if (!(await U.confirm('校验全部渠道', '将针对 ' + targets.length + ' 个模型、合计约 ' + total + ' 个渠道各发一次最小请求。渠道多时耗时较久且消耗少量额度，继续？', '开始校验'))) return;
    for (const m of targets) busy[m.id] = 'validate';
    render(root);
    for (const m of targets) {
      try { await API.validateUpstreams(m.id); } catch { /* 继续 */ }
      delete busy[m.id];
      render(root);
    }
    busy = {};
    U.toast('全渠道校验完成', 'ok');
    await fetchAll().catch(() => {});
    render(root);
  }

  async function fetchOfficial(root) {
    const btn = U.$('[data-act="fetch-official"]', root);
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    try {
      const r = await API.fetchOfficial();
      const added = r.added || [];
      U.toast('已从 ' + ((r.sources || []).join(' / ') || '未知来源') + ' 找到 ' + (r.found || 0) + ' 个模型' +
        (added.length ? '，新增 ' + added.length + ' 个' : '，无新增'), 'ok');
      if (added.length) {
        U.modal({
          title: '新增订阅模型 ' + added.length + ' 个',
          bodyHTML: '<div class="mono" style="user-select:text;line-height:1.9">' + added.map(U.esc).join('<br>') + '</div>',
          confirmLabel: '', cancelLabel: '知道了',
        });
      }
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('拉取失败：' + e.message, 'err'); }
    if (btn) { btn.disabled = false; btn.textContent = '拉取官方最新模型'; }
    render(root);
  }

  function wire(root) {
    U.delegate(root, 'change', '[data-act="only-probed"]', (_e, el) => { onlyProbed = el.checked; render(root); });
    U.delegate(root, 'click', '[data-act]', (e, el) => {
      const act = el.getAttribute('data-act');
      const row = el.closest('tr');
      const modelId = row && row.getAttribute('data-model');
      if (act === 'probe-all') return probeAll(root);
      if (act === 'validate-all') return validateAll(root);
      if (act === 'fetch-official') return fetchOfficial(root);
      if (!modelId) return;
      if (act === 'chain') return openChainEditor(modelId, root);
      if (act === 'probe') return doProbe(modelId, root);
      if (act === 'test') return doTest(modelId, root);
      if (act === 'validate') return doValidate(modelId, root);
      void e;
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.models = {
    title: '订阅模型',
    sub: () => '识别管道、枚举上游渠道、按序钉住并实测',
    actions: () => '<button class="btn btn-sm" data-act="refresh">重新读取</button>',
    async load(root) {
      root.innerHTML = '<div class="empty">加载中…</div>';
      try { await fetchAll(); } catch (e) { root.innerHTML = U.empty('读取失败：' + e.message); return; }
      render(root); wire(root);
    },
    async onAction(act) {
      if (act === 'refresh') { await window.APP.refresh(); window.APP.renderCurrent(); }
    },
  };
})();
