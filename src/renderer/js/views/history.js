// 请求历史：每条代理请求实际命中的渠道、耗时与尝试序列
(function () {
  'use strict';

  let history = [];
  let filter = '';

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const r = await API.history();
      history = r.history || [];
    } catch (e) { root.innerHTML = U.empty('读取失败：' + e.message); return; }
    render(root);
  }

  function render(root) {
    const list = filter ? history.filter((h) => String(h.model || '').includes(filter)) : history;
    const okCount = list.filter((h) => !h.error).length;
    const lat = list.map((h) => Number(h.ms)).filter((n) => isFinite(n) && n > 0);
    const avg = lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : 0;

    root.innerHTML =
      '<div class="kpi-row">' +
        tile('记录条数', U.fmtInt(list.length), '', '最多保留最近 100 条') +
        tile('成功', U.fmtInt(okCount), okCount === list.length ? 'is-good' : '', list.length ? Math.round((okCount / list.length) * 100) + '% 成功率' : '') +
        tile('失败', U.fmtInt(list.length - okCount), (list.length - okCount) > 0 ? 'is-bad' : '', '含上游错误与限流') +
        tile('平均耗时', avg ? U.fmtMs(avg) : '—', '', avg ? '仅统计有耗时记录的请求' : '暂无样本') +
      '</div>' +
      '<div class="card tight"><div class="row-gap" style="margin-bottom:10px">' +
        '<input class="input" id="histFilter" style="max-width:260px" placeholder="按模型名筛选…" value="' + U.esc(filter) + '">' +
        '<button class="btn btn-sm" data-act="clear-filter">清除</button>' +
        '<span class="spacer"></span>' +
        '<button class="btn btn-sm" data-act="reload">刷新</button>' +
      '</div>' +
      renderTable(list) + '</div>';
    wire(root);
  }

  function tile(label, value, cls, sub) {
    return '<div class="stat-tile"><div class="stat-label">' + U.esc(label) + '</div>' +
      '<div class="stat-value ' + (cls || '') + '">' + U.esc(value) + '</div>' +
      '<div class="stat-sub">' + U.esc(sub || '') + '</div></div>';
  }

  function renderTable(list) {
    if (!list.length) return U.empty(history.length ? '没有匹配的记录' : '还没有代理请求记录。用「测试台」发一条，或让客户端接入后使用。');
    const rows = list.map((h) => '<tr>' +
      '<td class="muted nowrap">' + U.fmtTime(h.ts) + '</td>' +
      '<td class="mono ellip nowrap" title="' + U.esc(h.model) + '">' + U.esc(h.model) + '</td>' +
      '<td class="nowrap">' + (h.account ? U.esc(h.account) : '<span class="muted">—</span>') + '</td>' +
      '<td>' + (h.provider ? '<span class="mono">' + U.esc(h.provider) + '</span>' : '<span class="muted">—</span>') + '</td>' +
      '<td class="mono ellip muted" title="' + U.esc(h.canonical || '') + '">' + U.esc(h.canonical || '—') + '</td>' +
      '<td class="nowrap">' + U.latCell(h.ms) + '</td>' +
      '<td class="nowrap">' + (h.stream ? '<span class="pill">流式</span>' : '<span class="muted">单次</span>') + '</td>' +
      '<td>' + U.attemptPath(h.trace, h.attempts) + '</td>' +
      '<td class="nowrap">' + (h.error
        ? U.statusBadge('bad', '失败') +
          '<span class="muted ellip-block" style="font-size:11px;max-width:190px;user-select:text" title="' + U.esc(h.error) + '">' + U.esc(String(h.error)) + '</span>'
        : U.statusBadge('ok', '成功')) + '</td>' +
    '</tr>').join('');

    return '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>时间</th><th>模型</th><th>账号</th><th>实际渠道</th><th>背后模型</th>' +
      '<th>耗时</th><th>类型</th><th>尝试路径</th><th>结果</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function wire(root) {
    const input = U.$('#histFilter', root);
    if (input) {
      U.on(input, 'input', () => {
        filter = input.value.trim();
        const list = filter ? history.filter((h) => String(h.model || '').includes(filter)) : history;
        const wrap = U.$('.table-wrap', root);
        if (wrap) wrap.outerHTML = renderTable(list);
        wire(root);
      });
    }
    U.delegate(root, 'click', '[data-act]', async (e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'clear-filter') { filter = ''; render(root); }
      if (act === 'reload') { await load(root); }
      void e;
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.history = {
    title: '请求历史',
    sub: () => '每条代理请求实际命中的上游渠道与耗时',
    actions: () => '<button class="btn btn-sm" data-act="refresh">刷新</button>',
    async load(root) { await load(root); },
    async onAction(act) { if (act === 'refresh') await load(document.getElementById('view')); },
  };
})();
