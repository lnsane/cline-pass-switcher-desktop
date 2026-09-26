// 完整目录：Cline 公开目录模型（订阅模型之外的模型，:free 变体可精确钉住）
(function () {
  'use strict';

  let catalog = [];
  let catalogCount = 0;
  let officialFetch = null;
  let query = '';
  let rendered = 120;

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const r = await API.models();
      catalog = r.catalog || [];
      catalogCount = r.catalogCount || catalog.length;
      officialFetch = r.officialFetch || null;
    } catch (e) { root.innerHTML = U.empty('读取失败：' + e.message); return; }
    render(root);
  }

  function render(root) {
    const q = query.trim().toLowerCase();
    const matched = q ? catalog.filter((id) => id.toLowerCase().includes(q)) : catalog;
    const list = matched.slice(0, rendered);

    root.innerHTML =
      '<div class="kpi-row">' +
        tile('目录模型', U.fmtInt(catalogCount), '', 'Cline 公开目录（非订阅模型）') +
        tile('匹配结果', U.fmtInt(matched.length), '', q ? '筛选：「' + q + '」' : '全部') +
        tile('官方清单', officialFetch ? U.fmtInt((officialFetch.found || 0)) : '—', '',
             officialFetch ? '最近拉取 ' + U.timeAgo(officialFetch.ts) + '（' + ((officialFetch.sources || []).join('/') || '无来源') + '）' : '未拉取') +
      '</div>' +
      '<div class="banner"><span class="b-ico">ℹ</span><div>' +
        '目录模型与订阅模型走不同管道：非 free 目录模型的 <span class="mono">provider.*</span> 会被网关丢弃；' +
        '<span class="mono">:free</span> 变体会真正透传到 OpenRouter，可精确钉住。' +
        '代理默认只对外暴露订阅模型，需要暴露完整目录请在「设置」里打开 <span class="mono">exposeCatalog</span>。' +
      '</div></div>' +
      '<div class="card tight">' +
        '<div class="row-gap" style="margin-bottom:10px">' +
          '<input class="input" id="catFilter" style="max-width:320px" placeholder="搜索模型 ID…" value="' + U.esc(query) + '">' +
          '<span class="spacer"></span>' +
          '<button class="btn btn-sm btn-primary" data-act="fetch-official">拉取官方最新订阅模型</button>' +
        '</div>' +
        (list.length
          ? '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
              '<thead><tr><th>模型 ID</th><th style="width:110px">类型</th><th style="width:120px"></th></tr></thead>' +
              '<tbody>' + list.map((id) => '<tr>' +
                '<td class="mono">' + U.esc(id) + '</td>' +
                '<td>' + (id.endsWith(':free') ? '<span class="badge b-good"><span class="b-ico">◆</span>可精确钉住</span>' : '<span class="badge"><span class="b-ico">·</span>网关自选</span>') + '</td>' +
                '<td><button class="btn btn-sm" data-copy="' + U.esc(id) + '">复制 ID</button></td>' +
              '</tr>').join('') + '</tbody></table></div></div>' +
              (matched.length > list.length ? '<div class="empty">还有 ' + (matched.length - list.length) + ' 个未显示　<button class="btn btn-sm" data-act="more">显示更多</button></div>' : '')
          : U.empty(q ? '没有匹配的模型' : '目录为空，点右上角拉取或稍后重试（需引擎能访问 Cline 接口）')) +
      '</div>';
    wire(root, list);
  }

  function tile(label, value, cls, sub) {
    return '<div class="stat-tile"><div class="stat-label">' + U.esc(label) + '</div>' +
      '<div class="stat-value ' + (cls || '') + '">' + U.esc(value) + '</div>' +
      '<div class="stat-sub">' + U.esc(sub || '') + '</div></div>';
  }

  function wire(root) {
    const input = U.$('#catFilter', root);
    if (input) {
      let t = null;
      U.on(input, 'input', () => {
        clearTimeout(t);
        t = setTimeout(() => { query = input.value; rendered = 120; render(root); const el = U.$('#catFilter', root); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } }, 180);
      });
    }
    U.delegate(root, 'click', '[data-copy]', (_e, el) => U.copy(el.getAttribute('data-copy'), '已复制模型 ID'));
    U.delegate(root, 'click', '[data-act]', async (_e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'more') { rendered += 200; render(root); }
      if (act === 'fetch-official') {
        el.disabled = true; el.textContent = '拉取中…';
        try {
          const r = await API.fetchOfficial();
          U.toast('找到 ' + (r.found || 0) + ' 个订阅模型，新增 ' + ((r.added || []).length) + ' 个', 'ok');
          if ((r.added || []).length) {
            U.modal({
              title: '新增订阅模型',
              bodyHTML: '<div class="mono" style="user-select:text;line-height:1.9">' + r.added.map(U.esc).join('<br>') + '</div>',
              confirmLabel: '', cancelLabel: '知道了',
            });
          }
          await load(root);
        } catch (e) { U.toast('拉取失败：' + e.message, 'err'); el.disabled = false; el.textContent = '拉取官方最新订阅模型'; }
      }
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.catalog = {
    title: '完整目录',
    sub: () => 'Cline 公开目录模型与官方订阅模型清单',
    actions: () => '<button class="btn btn-sm" data-act="refresh">重新读取</button>',
    async load(root) { rendered = 120; await load(root); },
    async onAction(act) { if (act === 'refresh') await load(document.getElementById('view')); },
  };
})();
