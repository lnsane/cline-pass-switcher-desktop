// 账号池：增删改、逐账号连通性测试、单账号/轮询、用量统计与真实额度
(function () {
  'use strict';

  let draft = [];       // 编辑中的账号池（保存前只存在内存）
  let draftMode = 'single';
  let draftActive = 0;
  let revealed = {};    // 密钥显隐
  let testResults = {}; // key -> {ok, ms, error, note}

  function render(root) {
    root.innerHTML = [
      '<div class="card">' +
        '<div class="card-head"><div class="card-title">账号池</div>' +
          '<div class="row-gap tight">' +
            '<button class="btn btn-sm" data-act="add">+ 添加账号</button>' +
            '<button class="btn btn-sm btn-primary" data-act="save">保存</button>' +
          '</div></div>' +
        '<div class="card-note" style="margin-bottom:10px">Cline Pass API Key（<span class="mono">sk_</span> 开头）。密钥只保存在本机数据目录的 config.json，不会外传。</div>' +
        renderMode() +
        renderList() +
      '</div>',
      renderQuotaCard(),
      renderStats(),
    ].join('');
  }

  function renderMode() {
    return '<div class="field"><label class="field-label">账号选择模式</label>' +
      '<div class="row-gap">' +
        '<label class="switch"><input type="radio" name="accmode" value="single" ' + (draftMode === 'single' ? 'checked' : '') + ' data-mode="single"><span class="track"></span><span class="switch-label">单账号（指定一个）</span></label>' +
        '<label class="switch"><input type="radio" name="accmode" value="roundrobin" ' + (draftMode === 'roundrobin' ? 'checked' : '') + ' data-mode="roundrobin"><span class="track"></span><span class="switch-label">轮询（多账号均衡）</span></label>' +
      '</div></div>';
  }

  function renderList() {
    if (!draft.length) return U.empty('还没有账号，点右上角「+ 添加账号」');
    const rows = draft.map((a, i) => {
      const tr = testResults[a.key];
      return '<tr data-idx="' + i + '">' +
        '<td>' + (draftMode === 'single'
          ? '<input type="radio" name="activeacc" ' + (draftActive === i ? 'checked' : '') + ' data-act="set-active" data-idx="' + i + '" title="设为当前账号">'
          : '<span class="muted">—</span>') + '</td>' +
        '<td><input class="input" style="height:28px" value="' + U.esc(a.name || '') + '" data-field="name" data-idx="' + i + '" placeholder="账号名"></td>' +
        '<td>' +
          '<div class="inline">' +
            '<input class="input mono" style="height:28px;min-width:220px" type="' + (revealed[i] ? 'text' : 'password') + '" value="' + U.esc(a.key || '') + '" data-field="key" data-idx="' + i + '" placeholder="sk_..." spellcheck="false">' +
            '<button class="btn btn-ghost btn-sm" data-act="reveal" data-idx="' + i + '">' + (revealed[i] ? '隐藏' : '显示') + '</button>' +
          '</div>' +
        '</td>' +
        '<td><label class="switch"><input type="checkbox" ' + (a.enabled !== false ? 'checked' : '') + ' data-act="toggle" data-idx="' + i + '"><span class="track"></span></label></td>' +
        '<td>' +
          (tr
            ? (tr.ok
              ? U.statusBadge('ok', tr.ms + ' ms')
              : '<span class="badge b-critical"><span class="b-ico">✘</span>' + U.esc((tr.error || '失败').slice(0, 40)) + '</span>')
            : '<span class="muted">未测</span>') +
        '</td>' +
        '<td><div class="row-gap tight">' +
          '<button class="btn btn-sm" data-act="test" data-idx="' + i + '"' + (a.key ? '' : ' disabled') + '>测试</button>' +
          '<button class="btn btn-sm btn-danger" data-act="del" data-idx="' + i + '">删除</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');
    return '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th style="width:34px"></th><th style="width:150px">名称</th><th>API Key</th><th style="width:70px">启用</th><th style="width:170px">连通性</th><th style="width:150px"></th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function renderStats() {
    const stats = window.APP.accountsRaw && window.APP.accountsRaw.stats;
    if (!stats || !Object.keys(stats).length) return '';
    const rows = Object.entries(stats).map(([name, s]) => '<tr>' +
      '<td>' + U.esc(name) + '</td>' +
      '<td class="num">' + U.fmtInt(s.requests) + '</td>' +
      '<td class="muted">' + U.timeAgo(s.lastUsed) + '</td>' +
      '<td>' + (s.lastError
        ? '<span class="badge b-critical"><span class="b-ico">✘</span>' + U.esc(String(s.lastError).slice(0, 48)) + '</span>'
        : '<span class="muted">—</span>') + '</td>' +
    '</tr>').join('');
    return '<div class="card tight"><div class="card-head"><div class="card-title">用量统计</div></div>' +
      '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>账号</th><th>请求数</th><th>最近使用</th><th>最近错误</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div></div>';
  }

  function renderQuotaCard() {
    if (!draft.length) return '';
    return '<div class="card"><div class="card-head"><div class="card-title">官方额度</div>' +
      '<div class="card-note">来自 Cline 用量接口 <button class="btn btn-ghost btn-sm" data-act="reload-quota">刷新</button></div></div>' +
      '<div id="quotaBody"><div class="empty">读取中…</div></div></div>';
  }

  async function loadQuotas(root) {
    const body = U.$('#quotaBody', root);
    if (!body) return;
    body.innerHTML = '<div class="empty">读取中…</div>';
    const rows = await Promise.all(draft.map(async (a) => {
      if (!a.key || a.enabled === false) return { name: a.name, skipped: !a.key ? '无密钥' : '已停用' };
      try { return { name: a.name, ...(await window.cp.quota.fetch(a.key)) }; }
      catch (e) { return { name: a.name, ok: false, error: e.message }; }
    }));
    body.innerHTML = rows.map((r) => {
      let inner;
      if (r.skipped) inner = '<span class="muted">' + U.esc(r.skipped) + '</span>';
      else if (!r.ok) inner = '<span class="badge b-serious"><span class="b-ico">⚿</span>读取失败</span> <span class="muted">' + U.esc(r.error || '') + '</span>';
      else {
        const byType = {};
        for (const it of r.limits || []) byType[it.type] = it;
        inner = ['five_hour', 'weekly', 'monthly'].filter((k) => byType[k]).map((k) => {
          const LABEL = { five_hour: '5 小时', weekly: '本周', monthly: '本月' };
          return U.meter(Number(byType[k].percentUsed) || 0, LABEL[k], '');
        }).join('');
      }
      return '<div style="padding:9px 0;border-bottom:1px solid var(--hairline-soft)">' +
        '<div style="font-size:12.5px;font-weight:600;margin-bottom:3px">' + U.esc(r.name || '(未命名)') + '</div>' + inner + '</div>';
    }).join('');
  }

  function syncFrom(root) {
    U.$$('[data-field]', root).forEach((el) => {
      const i = Number(el.getAttribute('data-idx'));
      const f = el.getAttribute('data-field');
      if (draft[i]) draft[i][f] = el.value;
    });
  }

  function wire(root) {
    U.delegate(root, 'change', '[data-act="toggle"]', (_e, el) => {
      const i = Number(el.getAttribute('data-idx'));
      draft[i].enabled = el.checked;
    });
    U.delegate(root, 'change', '[data-mode]', (_e, el) => {
      draftMode = el.getAttribute('data-mode');
      render(root);
      loadQuotas(root);
    });
    U.delegate(root, 'change', '[data-act="set-active"]', (_e, el) => { draftActive = Number(el.getAttribute('data-idx')); });
    U.delegate(root, 'input', '[data-field]', (_e, el) => {
      const i = Number(el.getAttribute('data-idx'));
      const f = el.getAttribute('data-field');
      if (draft[i]) draft[i][f] = el.value;
    });

    U.delegate(root, 'click', '[data-act]', async (e, el) => {
      const act = el.getAttribute('data-act');
      const i = Number(el.getAttribute('data-idx'));

      if (act === 'add') {
        syncFrom(root);
        draft.push({ name: '账号' + (draft.length + 1), key: '', enabled: true });
        render(root); loadQuotas(root);
      } else if (act === 'del') {
        syncFrom(root);
        const name = draft[i] && draft[i].name;
        if (!(await U.confirm('删除账号', '确定删除「' + (name || '未命名') + '」？未保存前不会写盘。', '删除'))) return;
        draft.splice(i, 1);
        if (draftActive >= draft.length) draftActive = Math.max(0, draft.length - 1);
        render(root); loadQuotas(root);
      } else if (act === 'reveal') {
        syncFrom(root);
        revealed[i] = !revealed[i];
        render(root); loadQuotas(root);
      } else if (act === 'test') {
        syncFrom(root);
        const key = (draft[i].key || '').trim();
        if (!key) return U.toast('请先填写 API Key', 'err');
        el.disabled = true; el.textContent = '测试中…';
        try {
          const r = await API.testAccount(key);
          testResults[key] = r;
          if (r.ok) U.toast('「' + (draft[i].name || '账号') + '」鉴权通过' + (r.ms ? '（' + r.ms + ' ms）' : '') + (r.note ? '：' + r.note : ''), 'ok');
          else U.toast((r.error || '测试失败'), 'err');
        } catch (err) {
          testResults[key] = { ok: false, error: err.message };
          U.toast('测试失败：' + err.message, 'err');
        }
        render(root); loadQuotas(root);
      } else if (act === 'save') {
        syncFrom(root);
        const payload = draft
          .map((a, idx) => ({ name: String(a.name || ('账号' + (idx + 1))).trim(), key: String(a.key || '').trim(), enabled: a.enabled !== false }))
          .filter((a) => a.key);
        if (!payload.length) return U.toast('至少需要一个填了 Key 的账号', 'err');
        try {
          await API.saveAccounts({ accounts: payload, mode: draftMode, active: draftActive });
          U.toast('已保存 ' + payload.length + ' 个账号', 'ok');
          await window.APP.refresh();
          await load(root);
        } catch (err) { U.toast('保存失败：' + err.message, 'err'); }
      } else if (act === 'reload-quota') {
        syncFrom(root);
        loadQuotas(root);
      }
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.accounts = {
    title: '账号池',
    sub: () => '多账号管理、连通性测试与官方额度',
    actions: () => '<button class="btn btn-sm" data-act="refresh">重新读取</button>',
    async load(root) {
      const r = await API.accounts().catch((e) => { root.innerHTML = U.empty('读取失败：' + e.message); throw e; });
      window.APP.accountsRaw = r;
      draft = (r.accounts || []).map((a) => ({ ...a }));
      draftMode = r.mode || 'single';
      draftActive = r.active || 0;
      testResults = {}; revealed = {};
      window.APP.accounts = draft;
      render(root);
      wire(root);
      loadQuotas(root);
    },
    async onAction(act) {
      if (act === 'refresh') { await window.APP.refresh(); window.APP.renderCurrent(); }
    },
    // 供「查找可用账号」等外部入口使用
    _internals: { getDraft: () => draft },
  };
})();
