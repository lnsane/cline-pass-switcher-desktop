// 用量统计：KPI、额度、按天趋势、按渠道/模型分布、逐条明细
//
// 数据来自引擎的 /api/usage*（见 src/main/engine/usage.js）。两个来源：
// - proxy：经本机代理的请求，带上游返回的真实成本
// - session：扫描 Claude Code 会话记录补的，只有 token 数（成本是估价）
// 界面上把两者分开呈现，不把估价混进真实账单里冒充。
(function () {
  'use strict';

  let DATA = null;        // /api/usage 的返回
  let RANGE = 14;         // 趋势天数
  let RECORDS = [];       // 明细
  let REC_FILTER = '';
  let SCANNING = false;

  // ---------- 数字格式 ----------
  // token 动辄百万级，用 万/亿 更好读（中文界面），英文界面则用 K/M/B。
  // 两者都保留精确值在 title 里，鼠标悬停能看到原始数字。
  const isZh = () => !window.I18N || window.I18N.lang === 'zh';
  function fmtTok(n) {
    const v = Number(n) || 0;
    if (isZh()) {
      if (v >= 1e8) return (v / 1e8).toFixed(2) + ' 亿';
      if (v >= 1e4) return (v / 1e4).toFixed(1) + ' 万';
      return U.fmtInt(v);
    }
    if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return U.fmtInt(v);
  }
  const fmtTokExact = (n) => (Number(n) || 0).toLocaleString(isZh() ? 'zh-CN' : 'en-US');
  function fmtCost(n) {
    const v = Number(n) || 0;
    if (!v) return '$0';
    if (v < 0.01) return '$' + v.toFixed(5);
    if (v < 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }

  async function fetchAll() {
    const [u, r] = await Promise.all([
      API.usage(RANGE),
      API.usageRecords({ limit: 300 }).catch(() => ({ records: [] })),
    ]);
    DATA = u;
    RECORDS = r.records || [];
  }

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try { await fetchAll(); }
    catch (e) {
      root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>读取用量失败：' + U.esc(e.message) + '</div></div>';
      return;
    }
    render(root);
  }

  function render(root) {
    root.innerHTML = [
      renderBanners(),
      renderKpis(),
      renderTrend(),
      renderBreakdown(),
      renderRecords(),
    ].join('');
    wire(root);
  }

  function renderBanners() {
    const out = [];
    const t = DATA.totals || {};
    if (!t.requests) {
      const src = (DATA.sources && DATA.sources.dirs) || [];
      const anyDir = src.some((d) => d.exists);
      out.push('<div class="banner b-warning"><span class="b-ico">⚠</span><div>' +
        '<strong>还没有用量记录</strong><br>' +
        '用「测试台」发一条请求、或让客户端接入本代理后使用，就会自动记下来。' +
        (anyDir
          ? '　也可以点右上角「扫描会话记录」，把 Claude Code 已有的历史补进来。'
          : '　（没找到 Claude Code 的会话目录，扫描可能取不到数据）') +
        '</div></div>');
    }
    // 会话扫描结果提示
    if (DATA.lastScan) {
      const s = DATA.lastScan;
      out.push('<div class="banner b-info" style="background:var(--surface-2);border-color:var(--hairline)">' +
        '<span class="b-ico">✓</span><div>扫描完成：读了 ' + s.files + ' 个文件、' + U.fmtInt(s.scanned) + ' 条记录，' +
        '新增 <b>' + U.fmtInt(s.added) + '</b> 条，跳过 ' + U.fmtInt(s.skipped) + ' 条（已记录过的）。</div></div>');
    }
    return out.join('');
  }

  function tile(label, value, cls, sub, title) {
    return '<div class="stat-tile"' + (title ? ' title="' + U.esc(title) + '"' : '') + '>' +
      '<div class="stat-label">' + U.esc(label) + '</div>' +
      '<div class="stat-value ' + (cls || '') + '">' + U.esc(value) + '</div>' +
      '<div class="stat-sub">' + U.esc(sub || '') + '</div></div>';
  }

  function renderKpis() {
    const t = DATA.totals || {};
    const okRate = t.requests ? Math.round((t.success / t.requests) * 100) : 0;
    const avgMs = t.msCount ? t.msSum / t.msCount : 0;
    const cacheHit = (t.input + t.cacheRead) > 0 ? (t.cacheRead / (t.input + t.cacheRead)) * 100 : 0;
    return '<div class="kpi-row">' +
      tile('请求数', U.fmtInt(t.requests || 0), '', T('近 {n} 天', { n: DATA.days })) +
      tile('成功率', t.requests ? okRate + '%' : '—', t.requests && okRate < 90 ? 'is-warn' : 'is-good',
           T('{a} 成功 / {b} 失败', { a: U.fmtInt(t.success || 0), b: U.fmtInt((t.requests || 0) - (t.success || 0)) })) +
      tile('输入 Token', fmtTok(t.input), '', T('{n} 原始输入', { n: fmtTokExact(t.input) }), fmtTokExact(t.input)) +
      tile('输出 Token', fmtTok(t.output), '', T('{n} 原始输出', { n: fmtTokExact(t.output) }), fmtTokExact(t.output)) +
      tile('缓存命中', fmtTok(t.cacheRead), '', cacheHit ? T('{n}% 命中率', { n: cacheHit.toFixed(1) }) : '暂无缓存',
           fmtTokExact(t.cacheRead) + ' ' + T('缓存读取') + (t.cacheCreation ? '，' + fmtTokExact(t.cacheCreation) + ' ' + T('缓存写入') : '')) +
      tile('花费', fmtCost(t.cost), '', costSub(t), costTitle(t)) +
      tile('平均耗时', avgMs ? U.fmtMs(avgMs) : '—', '', t.msCount ? T('{n} 次样本', { n: U.fmtInt(t.msCount) }) : '暂无样本') +
    '</div>';
  }

  // 花费的副标题：把「真实」与「估算」分开说清楚 ——
  // 混在一起会让人以为总额都是账单上的数
  function costSub(t) {
    if (!t.cost) return '暂无计费数据';
    if (t.costEstimated > 0 && t.costReal > 0) return T('真实 {a} + 估算 {b}', { a: fmtCost(t.costReal), b: fmtCost(t.costEstimated) });
    if (t.costReal > 0) return '全部来自上游真实账单';
    return '全部为定价表估算';
  }
  function costTitle(t) {
    const parts = [];
    if (t.costReal) parts.push(T('上游真实成本：') + fmtCost(t.costReal));
    if (t.costEstimated) parts.push(T('定价表估算：') + fmtCost(t.costEstimated));
    return parts.join('；');
  }

  // ---------- 趋势图 ----------
  // 手写内联 SVG（工程无图表库，CSP 也禁外链）。
  // 双序列：请求数 + 花费 —— 但**不做双 Y 轴**（那是图表大忌），
  // 而是拆成两张小图上下排列，各自独立刻度。
  function renderTrend() {
    const daily = (DATA.daily || []).slice(-RANGE);
    if (!daily.length) return '';
    const ranges = [7, 14, 30, 90];
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">按天趋势</div>' +
        '<div class="card-actions inline">' +
          ranges.map((d) => '<button class="btn btn-sm' + (d === RANGE ? ' btn-primary' : '') + '" data-act="range" data-days="' + d + '">' + d + ' 天</button>').join('') +
        '</div></div>' +
      sparkBlock('请求数', daily, (r) => r.requests, (r) => U.fmtInt(r.requests), 'var(--series-1)') +
      sparkBlock('花费', daily, (r) => r.cost || 0, (r) => fmtCost(r.cost), 'var(--series-2)', fmtCost) +
      sparkBlock('Token（输入 + 缓存）', daily, (r) => (r.input || 0) + (r.cacheRead || 0), (r) => fmtTok((r.input || 0) + (r.cacheRead || 0)), 'var(--good)') +
    '</div>';
  }

  // 把当天所有分桶的某个字段加总
  const daySum = (day, fn) => (day.rollups || []).reduce((n, r) => n + (Number(fn(r)) || 0), 0);

  function sparkBlock(label, daily, pick, fmt, color, axisFmt) {
    const vals = daily.map((d) => pick({ ...d, rollups: d.rollups, ...agg(d) }));
    const max = Math.max(...vals, 1);
    const W = 100, H = 22;   // viewBox 单位；实际尺寸由 CSS 拉伸
    const n = vals.length;
    const step = n > 1 ? W / (n - 1) : 0;
    const pts = vals.map((v, i) => [i * step, H - (v / max) * H]);
    const line = pts.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
    const area = '0,' + H + ' ' + line + ' ' + ((n - 1) * step).toFixed(2) + ',' + H;
    const total = vals.reduce((a, b) => a + b, 0);
    const last = daily[daily.length - 1];
    const peakIdx = vals.indexOf(Math.max(...vals));

    return '<div class="spark-row">' +
      '<div class="spark-head"><span class="spark-label">' + U.esc(label) + '</span>' +
        '<span class="spark-total">' + U.esc((axisFmt || U.fmtInt)(total)) +
        ' <span class="muted" style="font-weight:400">' + T('合计') + '</span></span></div>' +
      '<div class="spark-wrap">' +
        '<svg class="spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
          '<polygon points="' + area + '" fill="' + color + '" opacity="0.14"/>' +
          '<polyline points="' + line + '" fill="none" stroke="' + color + '" stroke-width="1.2" ' +
            'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>' +
        '</svg>' +
        '<div class="spark-axis"><span>' + U.esc(daily[0].date.slice(5)) + '</span>' +
          '<span class="muted">' + T('峰值') + ' ' + U.esc(fmt({ ...last, ...agg(daily[peakIdx]) })) + '（' + U.esc(daily[peakIdx].date.slice(5)) + '）</span>' +
          '<span>' + U.esc(last.date.slice(5)) + '</span></div>' +
      '</div></div>';
  }

  // 把一天的分桶合并成一个扁平对象，便于取值
  function agg(day) {
    const acc = { requests: 0, success: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, costReal: 0, costEstimated: 0 };
    for (const r of day.rollups || []) {
      for (const k of Object.keys(acc)) acc[k] += Number(r[k]) || 0;
    }
    return acc;
  }

  // ---------- 按渠道 / 模型分布 ----------
  function renderBreakdown() {
    const daily = DATA.daily || [];
    if (!daily.length) return '';
    // 跨所有天，按 渠道 和 模型 两个维度各自合并
    const byProvider = new Map();
    const byModel = new Map();
    const bySource = new Map();
    for (const day of daily) {
      for (const r of day.rollups || []) {
        const push = (map, key, label) => {
          const cur = map.get(key) || { key, label, requests: 0, input: 0, output: 0, cacheRead: 0, cost: 0, msSum: 0, msCount: 0 };
          cur.requests += r.requests || 0;
          cur.input += r.input || 0; cur.output += r.output || 0; cur.cacheRead += r.cacheRead || 0;
          cur.cost += r.cost || 0;
          cur.msSum += r.msSum || 0; cur.msCount += r.msCount || 0;
          map.set(key, cur);
        };
        push(byProvider, r.provider || '（未知渠道）', r.provider || '（未知渠道）');
        push(byModel, r.model || '（未知模型）', r.model || '（未知模型）');
        for (const [src, cnt] of Object.entries(r.bySource || {})) {
          push(bySource, src, src === 'proxy' ? '经本机代理' : src === 'session' ? '会话记录扫描' : src);
        }
      }
    }
    const table = (map, title, note, firstCol) => {
      const rows = [...map.values()].sort((a, b) => b.requests - a.requests);
      if (!rows.length) return '';
      const maxReq = Math.max(...rows.map((r) => r.requests), 1);
      return '<div class="card"><div class="card-head"><div class="card-title">' + U.esc(title) + '</div>' +
        '<div class="card-note">' + U.esc(note) + '</div></div>' +
        '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
        '<thead><tr><th>' + U.esc(firstCol) + '</th><th style="width:110px">请求数</th><th class="num">输入</th>' +
        '<th class="num">输出</th><th class="num">缓存读</th><th class="num">花费</th><th class="num">平均耗时</th></tr></thead><tbody>' +
        rows.map((r) => '<tr>' +
          '<td><div class="bar-cell"><span class="bar" style="width:' + Math.max(2, (r.requests / maxReq) * 100) + '%"></span>' +
            '<span class="mono ellip" title="' + U.esc(r.label) + '">' + U.esc(r.label) + '</span></div></td>' +
          '<td>' + U.fmtInt(r.requests) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.input)) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.output)) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.cacheRead)) + '</td>' +
          '<td class="num">' + U.esc(fmtCost(r.cost)) + '</td>' +
          '<td class="num">' + (r.msCount ? U.esc(U.fmtMs(r.msSum / r.msCount)) : '<span class="muted">—</span>') + '</td>' +
        '</tr>').join('') +
        '</tbody></table></div></div></div>';
    };
    return '<div class="grid-2">' +
      table(byProvider, '按渠道', '实际上游的请求分布', '渠道') +
      table(byModel, '按模型', '模型维度的用量分布', '模型') +
      '</div>' + table(bySource, '按数据来源', '代理记录的带真实成本；会话扫描的是估价', '来源');
  }

  // ---------- 逐条明细 ----------
  function renderRecords() {
    const list = REC_FILTER
      ? RECORDS.filter((r) => String(r.model || '').includes(REC_FILTER))
      : RECORDS;
    const head = '<div class="card tight"><div class="card-head"><div class="card-title">请求明细</div>' +
      '<div class="card-note">' + T('最近 {a} 条（引擎保留 {b} 条）', { a: U.fmtInt(RECORDS.length), b: U.fmtInt(DATA.detailLines || 0) }) + '</div></div>' +
      '<div class="row-gap" style="margin-bottom:10px">' +
        '<input class="input" id="useFilter" style="max-width:240px" placeholder="按模型名筛选…" value="' + U.esc(REC_FILTER) + '">' +
        '<button class="btn btn-sm" data-act="clear-filter">清除</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm" data-act="compact" title="删除超过 90 天的逐条明细（按天汇总不受影响）">清理旧明细</button>' +
      '</div>';
    if (!list.length) {
      return head + U.empty(RECORDS.length ? '没有匹配的记录' : '还没有明细记录') + '</div>';
    }
    return head + '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>时间</th><th>模型</th><th>来源</th><th>渠道</th>' +
      '<th class="num">输入</th><th class="num">输出</th><th class="num">缓存读</th>' +
      '<th class="num">花费</th><th class="num">耗时</th><th>结果</th></tr></thead><tbody>' +
      list.map((r) => '<tr>' +
        '<td class="muted nowrap">' + U.fmtTime(r.ts) + '</td>' +
        '<td class="mono ellip nowrap" title="' + U.esc(r.model || '') + '">' + U.esc(r.model || '—') + '</td>' +
        '<td class="nowrap">' + sourcePill(r.source) + '</td>' +
        '<td class="nowrap">' + (r.provider ? '<span class="mono">' + U.esc(r.provider) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.input)) + '">' + U.esc(fmtTok(r.input)) + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.output)) + '">' + U.esc(fmtTok(r.output)) + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.cacheRead)) + '">' + U.esc(fmtTok(r.cacheRead)) + '</td>' +
        '<td class="num">' + (r.cost != null
          ? U.esc(fmtCost(r.cost)) + (r.costSource === 'estimated' ? '<span class="muted" style="font-size:10px"> 估</span>' : '')
          : '<span class="muted">—</span>') + '</td>' +
        '<td class="num nowrap">' + (r.ms ? U.esc(U.fmtMs(r.ms)) : '<span class="muted">—</span>') + '</td>' +
        '<td class="nowrap">' + (r.error
          ? U.statusBadge('bad', '失败') + '<span class="muted ellip-block" style="font-size:11px;max-width:150px" title="' + U.esc(r.error) + '">' + U.esc(String(r.error)) + '</span>'
          : U.statusBadge('ok', '成功')) + '</td>' +
      '</tr>').join('') +
      '</tbody></table></div></div></div>';
  }

  function sourcePill(src) {
    if (src === 'proxy') return '<span class="pill" title="经本机代理，带上游真实成本">代理</span>';
    if (src === 'session') return '<span class="pill" title="扫描 Claude Code 会话记录补的，token 准确、成本为估价">会话</span>';
    return '<span class="pill">' + U.esc(src || '—') + '</span>';
  }

  function wire(root) {
    const input = U.$('#useFilter', root);
    if (input) {
      U.on(input, 'input', () => {
        REC_FILTER = input.value.trim();
        const card = input.closest('.card');
        if (card) card.outerHTML = renderRecords();
        wire(root);
      });
    }
    U.delegate(root, 'click', '[data-act]', async (e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'range') {
        RANGE = Number(el.getAttribute('data-days')) || 14;
        await load(document.getElementById('view'));
        // 副标题由 app.js 在 renderCurrent 时算一次，这里改了区间要自己刷新它
        const sub = document.getElementById('viewSub');
        if (sub) sub.textContent = window.VIEWS.usage.sub();
        // 工具栏按钮的高亮也要跟着走（actions() 是纯函数，重绘一次）
        const acts = document.getElementById('viewActions');
        if (acts) acts.innerHTML = window.VIEWS.usage.actions();
      } else if (act === 'clear-filter') {
        REC_FILTER = '';
        render(root);
      } else if (act === 'scan') {
        await doScan(root);
      } else if (act === 'compact') {
        const okGo = await U.confirm('清��旧明细', '删除 90 天以前的逐条请求记录？按天汇总与总计不受影响。', '清理');
        if (!okGo) return;
        try {
          const r = await API.usageCompact(90);
          U.toast('已清理 ' + U.fmtInt(r.removed) + ' 条，保留 ' + U.fmtInt(r.kept) + ' 条', 'ok');
          await load(root);
        } catch (err) { U.toast('清理失败：' + err.message, 'err'); }
      }
      void e;
    });
  }

  // 扫描会话记录：可能扫几百个文件，给明确的过程反馈
  async function doScan(root) {
    if (SCANNING) return;
    SCANNING = true;
    const btn = document.querySelector('[data-act="scan"]');
    if (btn) { btn.disabled = true; btn.textContent = '扫描中…'; }
    try {
      const r = await API.usageScan({ sinceDays: 30 });
      DATA.lastScan = r;
      U.toast('扫描完成：新增 ' + U.fmtInt(r.added) + ' 条，跳过 ' + U.fmtInt(r.skipped) + ' 条', 'ok');
      await load(root);
    } catch (e) {
      U.toast('扫描失败：' + e.message, 'err');
    } finally {
      SCANNING = false;
      const b2 = document.querySelector('[data-act="scan"]');
      if (b2) { b2.disabled = false; b2.textContent = '扫描会话记录'; }
    }
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.usage = {
    title: '用量统计',
    sub: () => {
      if (!DATA) return '请求量、Token、缓存与花费';
      const t = DATA.totals || {};
      const avail = DATA.available || {};
      return T('近 {d} 天 {r} 次请求 · 累计 {k} token · {c}', {
        d: DATA.days, r: U.fmtInt(t.requests || 0),
        k: U.fmtInt(t.input + t.output + t.cacheRead), c: fmtCost(t.cost),
      }) + (avail.from ? T('（数据自 {d} 起）', { d: avail.from }) : '');
    },
    actions: () => '<button class="btn btn-sm" data-act="scan" title="把 Claude Code 已有的会话历史补进统计（不开代理也能统计）">扫描会话记录</button>' +
      '<button class="btn btn-sm" data-act="refresh">刷新</button>',
    async load(root) { await load(root); },
    async onAction(act) {
      if (act === 'scan') await doScan(document.getElementById('view'));
      if (act === 'refresh') await load(document.getElementById('view'));
    },
  };
  // 视图外的调用入口（供 app.js 的全局刷新用）
  window.USAGE_VIEW = { reload: () => load(document.getElementById('view')) };
})();
