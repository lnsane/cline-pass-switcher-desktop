// 用量统计：KPI、按天/按小时趋势、按渠道/模型分布、逐条明细（实时）
//
// 数据来自引擎的 /api/usage*（见 src/main/engine/usage.js）。两个来源：
// - proxy：经本机代理的请求，带上游返回的真实成本（美元）
// - session：扫描 Claude Code 会话记录补的，token 准确、成本为估价
//
// 花费有**两个币种、两套口径**，刻意分开呈现、各自小计：
//   美元：经代理的真实账单，或非 DeepSeek 模型按 models.dev 定价表的估算
//   人民币：DeepSeek 官方价目表算的（含峰谷时段），与渠道无关
// 把两者相加或互相折算都是错的 —— 那就成了一个含汇率假设的假数字。
(function () {
  'use strict';

  // 趋势档位：当天（按小时）/ 7 / 31 / 60 / 90 天。
  // 「当天」用 hour 粒度 —— 一天只有一个点画不出趋势。
  const RANGES = [
    { days: 1, label: '当天', gran: 'hour' },
    { days: 7, label: '7天', gran: 'day' },
    { days: 31, label: '31天', gran: 'day' },
    { days: 60, label: '60天', gran: 'day' },
    { days: 90, label: '90天', gran: 'day' },
  ];
  const DEFAULT_RANGE = 7;

  let DATA = null;        // /api/usage 的返回
  let RANGE = DEFAULT_RANGE;
  let RECORDS = [];       // 明细（引擎已按时间倒序返回）
  let REC_FILTER = '';
  let REC_SOURCE = '';
  let SCANNING = false;
  let TIMER = null;       // 兜底轮询
  let UNSUB = null;       // 实时推送的退订
  let LIVE_N = 0;         // 本次会话经推送新增的条数
  let LAST_LIVE_TS = 0;
  let LOADING = false;

  const curRange = () => RANGES.find((r) => r.days === RANGE) || RANGES[1];

  // ---------- 数字格式 ----------
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

  // 美元：账单通常很小（一笔不到一美分），小数位要够，否则全是 $0.00
  function fmtUsd(n) {
    const v = Number(n) || 0;
    if (!v) return '$0';
    if (v < 0.01) return '$' + v.toFixed(5);
    if (v < 1) return '$' + v.toFixed(4);
    return '$' + v.toFixed(2);
  }
  // 人民币：官方价目表口径，同样可能很小
  function fmtCny(n) {
    const v = Number(n) || 0;
    if (!v) return '¥0';
    if (v < 0.01) return '¥' + v.toFixed(5);
    if (v < 1) return '¥' + v.toFixed(4);
    return '¥' + v.toFixed(2);
  }
  // 保持旧名字，界面上多数地方仍然按美元展示
  const fmtCost = fmtUsd;

  async function fetchAll() {
    const r = curRange();
    const [u, rec, cny] = await Promise.all([
      API.usage(r.days, r.gran),
      API.usageRecords({ limit: 300 }).catch(() => ({ records: [] })),
      API.usagePricingCny().catch(() => null),
    ]);
    DATA = u;
    DATA.pricingCny = cny;
    RECORDS = rec.records || [];
    DATA.recordsTruncated = !!rec.truncated;
  }

  async function load(root, { silent } = {}) {
    if (LOADING) return;
    LOADING = true;
    if (!silent && !DATA) root.innerHTML = '<div class="empty">' + T('加载中…') + '</div>';
    try { await fetchAll(); }
    catch (e) {
      if (!silent) {
        root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>' +
          T('读取用量失败：{msg}', { msg: U.esc(e.message) }) + '</div></div>';
      }
      LOADING = false;
      return;
    }
    LOADING = false;
    render(root);
  }

  function render(root) {
    root.innerHTML = [
      renderBanners(),
      renderKpis(),
      renderCnyCard(),
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
        '<strong>' + T('还没有用量记录') + '</strong><br>' +
        T('用「测试台」发一条请求、或让客户端接入本代理后使用，就会自动记下来。') +
        (anyDir
          ? T('　也可以点右上角「扫描会话记录」，把 Claude Code 已有的历史补进来。')
          : T('　（没找到 Claude Code 的会话目录，扫描可能取不到数据）')) +
        '</div></div>');
    }
    if (DATA.lastScan) {
      const s = DATA.lastScan;
      out.push('<div class="banner b-info" style="background:var(--surface-2);border-color:var(--hairline)">' +
        '<span class="b-ico">✓</span><div>' +
        T('扫描完成：读了 {f} 个文件、{s} 条记录，新增 {a} 条，跳过 {k} 条（已记录过的）。', {
          f: U.fmtInt(s.files), s: U.fmtInt(s.scanned), a: U.fmtInt(s.added), k: U.fmtInt(s.skipped),
        }) + '</div></div>');
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
    const scope = RANGE === 1 ? T('当天') : T('近 {n} 天', { n: RANGE });
    return '<div class="kpi-row">' +
      tile('请求数', U.fmtInt(t.requests || 0), '', scope) +
      tile('成功率', t.requests ? okRate + '%' : '—', t.requests && okRate < 90 ? 'is-warn' : 'is-good',
           T('{a} 成功 / {b} 失败', { a: U.fmtInt(t.success || 0), b: U.fmtInt((t.requests || 0) - (t.success || 0)) })) +
      tile('输入 Token', fmtTok(t.input), '', T('{n} 原始输入', { n: fmtTokExact(t.input) }), fmtTokExact(t.input)) +
      tile('输出 Token', fmtTok(t.output), '', T('{n} 原始输出', { n: fmtTokExact(t.output) }), fmtTokExact(t.output)) +
      tile('缓存命中', fmtTok(t.cacheRead), '', cacheHit ? T('{n}% 命中率', { n: cacheHit.toFixed(1) }) : T('暂无缓存'),
           fmtTokExact(t.cacheRead) + ' ' + T('缓存读取') + (t.cacheCreation ? '，' + fmtTokExact(t.cacheCreation) + ' ' + T('缓存写入') : '')) +
      // DeepSeek 有官方人民币价时，主位显示人民币；否则显示美元
      (t.costCny > 0
        ? tile('花费', fmtCny(t.costCny), '', cnySub(t), cnyTitle(t))
        : tile('花费', fmtUsd(t.cost), '', costSub(t), costTitle(t))) +
      tile('平均耗时', avgMs ? U.fmtMs(avgMs) : '—', '', t.msCount ? T('{n} 次样本', { n: U.fmtInt(t.msCount) }) : T('暂无样本')) +
      (t.costCny > 0 ? tile('上游账单', fmtUsd(t.cost), '', costSub(t), costTitle(t)) : '') +
    '</div>';
  }

  // 美元花费的副标题：把「真实」与「估算」分开说清楚
  function costSub(t) {
    if (!t.cost) return T('暂无计费数据');
    if (t.costEstimated > 0 && t.costReal > 0) return T('真实 {a} + 估算 {b}', { a: fmtUsd(t.costReal), b: fmtUsd(t.costEstimated) });
    if (t.costReal > 0) return T('全部来自上游真实账单');
    return T('全部为定价表估算');
  }
  function costTitle(t) {
    const parts = [];
    if (t.costReal) parts.push(T('上游真实成本：') + fmtUsd(t.costReal));
    if (t.costEstimated) parts.push(T('定价表估算：') + fmtUsd(t.costEstimated));
    return parts.join('；');
  }
  // 人民币的副标题：说清是官方价目表、含峰谷
  function cnySub(t) {
    if (!t.costCny) return T('暂无人民币计价数据');
    if (t.costCnyPeak > 0) return T('其中高峰时段 {a}', { a: fmtCny(t.costCnyPeak) });
    return T('全部为空闲时段计价');
  }
  function cnyTitle(t) {
    const parts = [T('按 DeepSeek 官方价目表（元/百万 token）计算')];
    if (t.costCnyPeak) parts.push(T('高峰时段：') + fmtCny(t.costCnyPeak));
    if (t.costCny - t.costCnyPeak > 0) parts.push(T('空闲时段：') + fmtCny(t.costCny - t.costCnyPeak));
    return parts.join('；');
  }

  // ---------- 人民币计价说明卡 ----------
  // 放一张卡片把「现在什么价、为什么是这个价」讲清楚。
  // 价格随时段变（高峰是空闲的两倍），不讲清楚用户会以为算错了。
  function renderCnyCard() {
    const t = DATA.totals || {};
    const c = DATA.cny || {};
    const now = c.now || {};
    if (!t.costCny && !now.reason) return '';
    const badge = now.peak ? 'is-warn' : 'is-good';
    const priceRows = Object.entries((DATA.pricingCny && DATA.pricingCny.cny && DATA.pricingCny.cny.models) || {});
    const band = now.peak ? 'peak' : 'offpeak';
    // 用时段的 code 自己查字典，而不是把引擎给的中文 reason 拼进句子 ——
    // 拼进去的话切英文会留一段中文（译文按整句查表，拼进来的部分没人翻）。
    const bandLabel = ({ holiday: '法定节假日（全天空闲）', weekend: '周末（全天空闲）', peak: '工作日高峰时段', offpeak: '工作日空闲时段' })[now.code] || '—';
    return '<div class="card tight"><div class="card-head">' +
      '<div class="card-title">' + T('DeepSeek 人民币计价') + '</div>' +
      '<div class="card-note">' + T('官方价目表 · 元/百万 token') + '</div>' +
      '<span class="spacer"></span>' +
      '<span class="badge ' + badge + '">' + U.esc(T('当前：{r}', { r: T(bandLabel) })) + '</span>' +
      '</div>' +
      (t.costCny
        ? '<div class="grid-2" style="margin-bottom:10px">' +
          '<div><div class="stat-label">' + T('本区间 DeepSeek 花费') + '</div>' +
          '<div class="stat-value is-good">' + U.esc(fmtCny(t.costCny)) + '</div>' +
          '<div class="stat-sub">' + U.esc(cnySub(t)) + '</div></div>' +
          '<div><div class="stat-label">' + T('同期上游账单（美元）') + '</div>' +
          '<div class="stat-value">' + U.esc(fmtUsd(t.cost)) + '</div>' +
          '<div class="stat-sub">' + U.esc(costSub(t)) + '</div></div>' +
          '</div>'
        : '') +
      (priceRows.length
        ? '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
          '<thead><tr><th>' + T('模型') + '</th><th class="num">' + T('缓存命中输入') + '</th>' +
          '<th class="num">' + T('缓存未命中输入') + '</th><th class="num">' + T('输出') + '</th></tr></thead><tbody>' +
          priceRows.map(([k, m]) => '<tr>' +
            '<td><span class="mono">' + U.esc(k) + '</span> <span class="muted">' + U.esc(m.n) + '</span></td>' +
            '<td class="num">¥' + U.esc(String(m.cacheHit[band])) + '</td>' +
            '<td class="num">¥' + U.esc(String(m.cacheMiss[band])) + '</td>' +
            '<td class="num">¥' + U.esc(String(m.output[band])) + '</td>' +
            '</tr>').join('') +
          '</tbody></table></div></div>' +
          '<div class="hint" style="margin-top:8px">' +
          U.esc(T('高峰时段为北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00，其余（含周末与节假日）为空闲时段，空闲价为高峰价的一半。缓存写入并入「未命中输入」计价。')) +
          '</div>'
        : '') +
      '</div>';
  }

  // ---------- 趋势图 ----------
  // 手写内联 SVG（工程无图表库，CSP 也禁外链）。
  // 多条序列各自成图、各自刻度 —— 不做双 Y 轴。
  function renderTrend() {
    const daily = DATA.daily || [];
    // 档位按钮必须在**任何**情况下都渲染出来，哪怕这段区间没有数据 ——
    // 否则用户选了「当天」发现没数据，就再也点不回 7/31/90 天了（按钮随卡片一起消失了）。
    const rangeBar = '<div class="card-actions inline">' +
      RANGES.map((r) => '<button class="btn btn-sm' + (r.days === RANGE ? ' btn-primary' : '') +
        '" data-act="range" data-days="' + r.days + '">' + U.esc(T(r.label)) + '</button>').join('') +
      '</div>';
    if (!daily.length) {
      return '<div class="card"><div class="card-head"><div class="card-title">' + T('按天趋势') + '</div>' +
        rangeBar + '</div>' + U.empty(T('这段区间还没有数据')) + '</div>';
    }
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">' + T('按天趋势') + '</div>' +
        rangeBar +
        '</div>' +
      (DATA.granularity === 'hour' ? '<div class="hint" style="margin-bottom:8px">' +
        U.esc(T('按小时展示今天（0-23 点）。小时数据只保留最近几天。')) + '</div>' : '') +
      sparkBlock('请求数', daily, (r) => r.requests, (r) => U.fmtInt(r.requests), 'var(--series-1)') +
      (DATA.totals && DATA.totals.costCny > 0
        ? sparkBlock('花费（人民币）', daily, (r) => r.costCny || 0, (r) => fmtCny(r.costCny), 'var(--good)', fmtCny)
        : sparkBlock('花费（美元）', daily, (r) => r.cost || 0, (r) => fmtUsd(r.cost), 'var(--series-2)', fmtUsd)) +
      sparkBlock('Token（输入 + 缓存）', daily, (r) => (r.input || 0) + (r.cacheRead || 0),
        (r) => fmtTok((r.input || 0) + (r.cacheRead || 0)), 'var(--series-2)') +
      '</div>';
  }

  function sparkBlock(label, daily, pick, fmt, color, axisFmt) {
    const merged = daily.map((d) => ({ ...d, agg: agg(d) }));
    const vals = merged.map((d) => pick(d.agg));
    const max = Math.max(...vals, 1);
    const W = 100, H = 22;
    const n = vals.length;
    const step = n > 1 ? W / (n - 1) : 0;
    const pts = vals.map((v, i) => [i * step, H - (v / max) * H]);
    const line = pts.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join(' ');
    const area = '0,' + H + ' ' + line + ' ' + ((n - 1) * step).toFixed(2) + ',' + H;
    const total = vals.reduce((a, b) => a + b, 0);
    const last = merged[merged.length - 1];
    const peakIdx = vals.indexOf(Math.max(...vals));
    // 标签：天粒度显示 MM-DD，小时粒度显示 HH 点
    const lbl = (s) => (String(s).includes('T') ? String(s).split('T')[1] + ':00' : String(s).slice(5));

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
        '<div class="spark-axis"><span>' + U.esc(lbl(merged[0].date)) + '</span>' +
          '<span class="muted">' + T('峰值') + ' ' + U.esc(fmt(vals[peakIdx])) + '（' + U.esc(lbl(merged[peakIdx].date)) + '）</span>' +
          '<span>' + U.esc(lbl(last.date)) + '</span></div>' +
      '</div></div>';
  }

  function agg(day) {
    const acc = {
      requests: 0, success: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      cost: 0, costReal: 0, costEstimated: 0, costCny: 0, costCnyPeak: 0,
    };
    for (const r of day.rollups || []) {
      for (const k of Object.keys(acc)) acc[k] += Number(r[k]) || 0;
    }
    return acc;
  }

  // ---------- 按渠道 / 模型分布 ----------
  function renderBreakdown() {
    const daily = DATA.daily || [];
    if (!daily.length) return '';
    const byProvider = new Map();
    const byModel = new Map();
    const bySource = new Map();
    for (const day of daily) {
      for (const r of day.rollups || []) {
        const push = (map, key, label) => {
          const cur = map.get(key) || {
            key, label, requests: 0, input: 0, output: 0, cacheRead: 0,
            cost: 0, costCny: 0, msSum: 0, msCount: 0,
          };
          cur.requests += r.requests || 0;
          cur.input += r.input || 0; cur.output += r.output || 0; cur.cacheRead += r.cacheRead || 0;
          cur.cost += r.cost || 0;
          cur.costCny += r.costCny || 0;
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
      // 花费列：这一行有人民币价就显示人民币，否则显示美元 —— 两个币种不混在一列里相加
      const costCell = (r) => (r.costCny > 0
        ? U.esc(fmtCny(r.costCny))
        : (r.cost ? U.esc(fmtUsd(r.cost)) : '<span class="muted">—</span>'));
      return '<div class="card"><div class="card-head"><div class="card-title">' + U.esc(title) + '</div>' +
        '<div class="card-note">' + U.esc(note) + '</div></div>' +
        '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
        '<thead><tr><th>' + U.esc(firstCol) + '</th><th style="width:110px">' + T('请求数') + '</th><th class="num">' + T('输入') + '</th>' +
        '<th class="num">' + T('输出') + '</th><th class="num">' + T('缓存读') + '</th><th class="num">' + T('花费') + '</th><th class="num">' + T('平均耗时') + '</th></tr></thead><tbody>' +
        rows.map((r) => '<tr>' +
          '<td><div class="bar-cell"><span class="bar" style="width:' + Math.max(2, (r.requests / maxReq) * 100) + '%"></span>' +
            '<span class="mono ellip" title="' + U.esc(r.label) + '">' + U.esc(r.label) + '</span></div></td>' +
          '<td>' + U.fmtInt(r.requests) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.input)) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.output)) + '</td>' +
          '<td class="num">' + U.esc(fmtTok(r.cacheRead)) + '</td>' +
          '<td class="num">' + costCell(r) + '</td>' +
          '<td class="num">' + (r.msCount ? U.esc(U.fmtMs(r.msSum / r.msCount)) : '<span class="muted">—</span>') + '</td>' +
        '</tr>').join('') +
        '</tbody></table></div></div></div>';
    };
    return '<div class="grid-2">' +
      table(byProvider, T('按渠道'), T('实际上游的请求分布'), T('渠道')) +
      table(byModel, T('按模型'), T('模型维度的用量分布'), T('模型')) +
      '</div>' + table(bySource, T('按数据来源'), T('代理记录的带真实成本；会话扫描的是估价'), T('来源'));
  }

  // ---------- 逐条明细 ----------
  // 引擎已按时间倒序返回（最新的在最上面），这里只做筛选与渲染。
  function renderRecords() {
    let list = RECORDS;
    if (REC_FILTER) list = list.filter((r) => String(r.model || '').includes(REC_FILTER));
    if (REC_SOURCE) list = list.filter((r) => r.source === REC_SOURCE);
    const head = '<div class="card tight"><div class="card-head"><div class="card-title">' + T('请求详情') + '</div>' +
      '<div class="card-note">' + T('最近 {a} 条（引擎保留 {b} 条）· 最新在前', { a: U.fmtInt(RECORDS.length), b: U.fmtInt(DATA.detailLines || 0) }) + '</div>' +
      '<span class="spacer"></span>' +
      (LIVE_N > 0 ? '<span class="badge is-good" title="' + U.esc(T('本次打开的会话里，通过实时推送新增的记录数')) + '">' +
        U.esc(T('实时 +{n}', { n: U.fmtInt(LIVE_N) })) + '</span>' : '') +
      '</div>' +
      '<div class="row-gap" style="margin-bottom:10px">' +
        '<input class="input" id="useFilter" style="max-width:240px" placeholder="' + U.esc(T('按模型名筛选…')) + '" value="' + U.esc(REC_FILTER) + '">' +
        '<select class="input" id="useSource" style="max-width:150px">' +
          '<option value=""' + (REC_SOURCE ? '' : ' selected') + '>' + U.esc(T('全部来源')) + '</option>' +
          '<option value="proxy"' + (REC_SOURCE === 'proxy' ? ' selected' : '') + '>' + U.esc(T('代理')) + '</option>' +
          '<option value="session"' + (REC_SOURCE === 'session' ? ' selected' : '') + '>' + U.esc(T('会话')) + '</option>' +
        '</select>' +
        '<button class="btn btn-sm" data-act="clear-filter">' + U.esc(T('清除')) + '</button>' +
        '<span class="spacer"></span>' +
        (DATA.recordsTruncated ? '<span class="muted" style="font-size:11.5px">' + U.esc(T('（记录很多，可能还有更早的未显示）')) + '</span>' : '') +
        '<button class="btn btn-sm" data-act="recompute" title="' + U.esc(T('按官方价目表重算全部历史记录的人民币金额（老数据没有这个字段，不重算会显示 ¥0）')) + '">' + U.esc(T('重算人民币')) + '</button>' +
        '<button class="btn btn-sm" data-act="compact" title="' + U.esc(T('删除超过 90 天的逐条明细（按天汇总不受影响）')) + '">' + U.esc(T('清理旧明细')) + '</button>' +
      '</div>';
    if (!list.length) {
      return head + U.empty(RECORDS.length ? T('没有匹配的记录') : T('还没有明细记录')) + '</div>';
    }
    return head + '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>' + T('时间') + '</th><th>' + T('模型') + '</th><th>' + T('来源') + '</th><th>' + T('渠道') + '</th>' +
      '<th class="num">' + T('输入') + '</th><th class="num">' + T('输出') + '</th><th class="num">' + T('缓存读') + '</th>' +
      '<th class="num">' + T('花费') + '</th><th class="num">' + T('耗时') + '</th><th>' + T('结果') + '</th></tr></thead><tbody>' +
      list.map((r) => '<tr>' +
        '<td class="muted nowrap">' + U.fmtTime(r.ts) + '</td>' +
        '<td class="mono ellip nowrap" title="' + U.esc(r.model || '') + '">' + U.esc(r.model || '—') + '</td>' +
        '<td class="nowrap">' + sourcePill(r.source) + '</td>' +
        '<td class="nowrap">' + (r.provider ? '<span class="mono">' + U.esc(r.provider) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.input)) + '">' + U.esc(fmtTok(r.input)) + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.output)) + '">' + U.esc(fmtTok(r.output)) + '</td>' +
        '<td class="num" title="' + U.esc(fmtTokExact(r.cacheRead)) + '">' + U.esc(fmtTok(r.cacheRead)) + '</td>' +
        '<td class="num nowrap">' + costCellRec(r) + '</td>' +
        '<td class="num nowrap">' + (r.ms ? U.esc(U.fmtMs(r.ms)) : '<span class="muted">—</span>') + '</td>' +
        '<td class="nowrap">' + (r.error
          ? U.statusBadge('bad', T('失败')) + '<span class="muted ellip-block" style="font-size:11px;max-width:150px" title="' + U.esc(r.error) + '">' + U.esc(String(r.error)) + '</span>'
          : U.statusBadge('ok', T('成功'))) + '</td>' +
      '</tr>').join('') +
      '</tbody></table></div></div></div>';
  }

  // 明细行的花费：优先人民币（DeepSeek 有官方价），并在悬停里说明时段；
  // 否则显示美元，估算的标「估」
  function costCellRec(r) {
    if (r.costCny != null && r.costCny > 0) {
      const title = r.costCnyPeak
        ? T('高峰时段计价；同期上游账单 {u}', { u: r.cost != null ? fmtUsd(r.cost) : '—' })
        : T('空闲时段计价；同期上游账单 {u}', { u: r.cost != null ? fmtUsd(r.cost) : '—' });
      return '<span title="' + U.esc(title) + '">' + U.esc(fmtCny(r.costCny)) + '</span>';
    }
    if (r.cost != null) {
      return U.esc(fmtUsd(r.cost)) + (r.costSource === 'estimated' ? '<span class="muted" style="font-size:10px"> ' + T('估') + '</span>' : '');
    }
    return '<span class="muted">—</span>';
  }
  function sourcePill(src) {
    if (src === 'proxy') return '<span class="pill" title="' + U.esc(T('经本机代理，带上游真实成本')) + '">' + T('代理') + '</span>';
    if (src === 'session') return '<span class="pill" title="' + U.esc(T('扫描 Claude Code 会话记录补的，token 准确、成本为估价')) + '">' + T('会话') + '</span>';
    return '<span class="pill">' + U.esc(src || '—') + '</span>';
  }

  function wire(root) {
    const input = U.$('#useFilter', root);
    if (input) {
      U.on(input, 'input', () => {
        REC_FILTER = input.value.trim();
        const card = input.closest('.card');
        if (card) { card.outerHTML = renderRecords(); wire(root); }
      });
    }
    const sel = U.$('#useSource', root);
    if (sel) {
      U.on(sel, 'change', () => {
        REC_SOURCE = sel.value;
        const card = sel.closest('.card');
        if (card) { card.outerHTML = renderRecords(); wire(root); }
      });
    }
    U.delegate(root, 'click', '[data-act]', async (e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'range') {
        RANGE = Number(el.getAttribute('data-days')) || DEFAULT_RANGE;
        await load(document.getElementById('view'), { silent: true });
        refreshChrome();
      } else if (act === 'clear-filter') {
        REC_FILTER = ''; REC_SOURCE = '';
        render(root);
      } else if (act === 'recompute') {
        const okGo = await U.confirm(T('重算人民币金额'),
          T('按 DeepSeek 官方价目表重算全部历史记录的人民币金额。加入人民币计价之前的老记录没有这个字段，不重算的话它们会一直显示 ¥0。重算是只读重推，金额不会叠加；记录很多时需要几秒。'),
          T('重算'));
        if (!okGo) return;
        el.disabled = true;
        const old = el.textContent;
        el.textContent = T('重算中…');
        try {
          const r = await API.usageRecompute();
          U.toast(T('已重算 {a} 条记录，合计 {b}', { a: U.fmtInt(r.records), b: fmtCny(r.cny) }), 'ok');
          await load(root, { silent: true });
        } catch (err) {
          U.toast(T('重算失败：{msg}', { msg: err.message }), 'err');
        } finally {
          el.disabled = false;
          el.textContent = old;
        }
      } else if (act === 'compact') {
        const okGo = await U.confirm(T('清理旧明细'), T('删除 90 天以前的逐条请求记录？按天汇总与总计不受影响。'), T('清理'));
        if (!okGo) return;
        try {
          const r = await API.usageCompact(90);
          U.toast(T('已清理 {a} 条，保留 {b} 条', { a: U.fmtInt(r.removed), b: U.fmtInt(r.kept) }), 'ok');
          await load(root, { silent: true });
        } catch (err) { U.toast(T('清理失败：{msg}', { msg: err.message }), 'err'); }
      }
      void e;
    });
  }

  // 区间/语言变了要同步副标题与工具栏按钮高亮（app.js 只在切视图时算一次）
  function refreshChrome() {
    const sub = document.getElementById('viewSub');
    if (sub) sub.textContent = typeof window.VIEWS.usage.sub === 'function' ? window.VIEWS.usage.sub() : '';
    const acts = document.getElementById('viewActions');
    if (acts) acts.innerHTML = window.VIEWS.usage.actions();
  }

  async function doScan(root) {
    if (SCANNING) return;
    SCANNING = true;
    const btn = document.querySelector('[data-act="scan"]');
    if (btn) { btn.disabled = true; btn.textContent = T('扫描中…'); }
    try {
      const r = await API.usageScan({ sinceDays: 90 });
      DATA.lastScan = r;
      U.toast(T('扫描完成：新增 {a} 条，跳过 {b} 条', { a: U.fmtInt(r.added), b: U.fmtInt(r.skipped) }), 'ok');
      await load(root, { silent: true });
    } catch (e) {
      U.toast(T('扫描失败：{msg}', { msg: e.message }), 'err');
    } finally {
      SCANNING = false;
      const b2 = document.querySelector('[data-act="scan"]');
      if (b2) { b2.disabled = false; b2.textContent = T('扫描会话记录'); }
    }
  }

  // ---------- 实时 ----------
  // 两条路：
  //  1. 引擎推送（onUsageRecord）：新记录一到就更新，几乎无延迟
  //  2. 兜底轮询：万一推送没挂上（引擎独立运行、或事件丢失），最多 N 秒也能追上
  // 推送与轮询都走同一个 scheduleRefresh，避免同一时刻并发拉两次。
  const POLL_MS = 30000;
  let pending = null;

  function isActive() {
    return window.APP && window.APP.view === 'usage' && !document.hidden;
  }

  function scheduleRefresh() {
    if (!isActive() || pending) return;
    // 合并短时间内的多次推送：一次请求潮可能连着记十几条，
    // 每来一条都重绘会让界面闪个不停。
    pending = setTimeout(async () => {
      pending = null;
      if (!isActive()) return;
      await load(document.getElementById('view'), { silent: true });
    }, 800);
  }

  function startLive() {
    stopLive();
    // 引擎推送
    if (window.cp && window.cp.onUsageRecord) {
      try {
        UNSUB = window.cp.onUsageRecord((entry) => {
          if (!entry) return;
          // 只统计「本次打开之后」新增的，避免把加载时就有的算成实时新增
          if (Number(entry.ts) > LAST_LIVE_TS) LIVE_N += 1;
          scheduleRefresh();
        });
      } catch { /* 推送不可用就只靠轮询 */ }
    }
    TIMER = setInterval(scheduleRefresh, POLL_MS);
    // 从后台切回来时立刻补一次，别让用户盯着旧数据
    document.addEventListener('visibilitychange', onVisible);
  }

  function onVisible() {
    if (!document.hidden && isActive()) scheduleRefresh();
  }

  function stopLive() {
    if (TIMER) { clearInterval(TIMER); TIMER = null; }
    if (UNSUB) { try { UNSUB(); } catch { /* 已退订 */ } UNSUB = null; }
    if (pending) { clearTimeout(pending); pending = null; }
    document.removeEventListener('visibilitychange', onVisible);
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.usage = {
    title: '用量统计',
    sub: () => {
      if (!DATA) return '请求量、Token、缓存与花费';
      const t = DATA.totals || {};
      const avail = DATA.available || {};
      const scope = RANGE === 1 ? T('当天') : T('近 {d} 天', { d: DATA.days });
      const cost = t.costCny > 0 ? fmtCny(t.costCny) : fmtUsd(t.cost);
      return scope + ' ' + T('{r} 次请求 · 累计 {k} token · {c}', {
        r: U.fmtInt(t.requests || 0),
        k: U.fmtInt(t.input + t.output + t.cacheRead), c: cost,
      }) + (avail.from ? T('（数据自 {d} 起）', { d: avail.from }) : '');
    },
    actions: () => '<button class="btn btn-sm" data-act="scan" title="' +
      U.esc(T('把 Claude Code 已有的会话历史补进统计（不开代理也能统计）')) + '">' + T('扫描会话记录') + '</button>' +
      '<button class="btn btn-sm" data-act="refresh">' + T('刷新') + '</button>',
    async load(root) {
      LIVE_N = 0;
      LAST_LIVE_TS = Date.now();
      await load(root);
      startLive();
    },
    async onAction(act) {
      if (act === 'scan') await doScan(document.getElementById('view'));
      if (act === 'refresh') await load(document.getElementById('view'), { silent: true });
    },
    // 离开视图时停掉推送与轮询，别让它在后台一直跑
    destroy: stopLive,
  };
  window.USAGE_VIEW = { reload: () => load(document.getElementById('view'), { silent: true }) };
})();
