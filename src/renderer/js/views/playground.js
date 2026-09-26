// 测试台：任选模型与提示词，走真实代理链路发一条请求，回读网关实际采纳的上游
(function () {
  'use strict';

  let models = [];
  let lastRaw = null;

  async function ensureModels() {
    if (models.length) return models;
    const m = await API.models();
    models = (m.subscription || []).map((s) => s.id);
    return models;
  }

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try { await ensureModels(); } catch (e) {
      root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>读取模型列表失败：' + U.esc(e.message) + '</div></div>';
      return;
    }
    const dflt = models[0] || 'cline-pass/glm-5.3-flash';
    root.innerHTML =
      '<div class="grid-2">' +
        '<div class="card">' +
          '<div class="card-head"><div class="card-title">请求</div>' +
            '<div class="card-note">经本机代理转发，与客户端走同一条链路</div></div>' +
          '<div class="field"><label class="field-label">模型</label>' +
            '<input class="input mono" id="pgModel" list="pgModels" value="' + U.esc(dflt) + '" spellcheck="false">' +
            '<datalist id="pgModels">' + models.map((id) => '<option value="' + U.esc(id) + '"></option>').join('') + '</datalist>' +
            '<div class="field-hint">钉住配置在「订阅模型」页维护；这里按已保存的配置发起。</div></div>' +
          '<div class="field"><label class="field-label">提示词</label>' +
            '<textarea class="textarea" id="pgPrompt" rows="5" placeholder="给模型发一句话…">用一句话说明你是什么模型。</textarea></div>' +
          '<div class="field" style="max-width:180px"><label class="field-label">max_tokens</label>' +
            '<input class="input" id="pgMax" type="number" min="16" max="8192" value="256"></div>' +
          '<div class="row-gap">' +
            '<button class="btn btn-primary" data-act="send">发送</button>' +
            '<button class="btn" data-act="pincheck">钉住验证</button>' +
          '</div>' +
          '<div class="field-hint" style="margin-top:8px">「发送」按已保存的渠道链走完整回退逻辑；「钉住验证」额外回读网关是否真正采纳了钉住。</div>' +
        '</div>' +
        '<div class="card"><div class="card-head"><div class="card-title">响应</div>' +
          '<div class="card-note" id="pgMs"></div></div>' +
          '<div id="pgOut" class="muted" style="font-size:12.5px">尚未发送请求。</div></div>' +
      '</div>';

    wire(root);
  }

  function renderOut(html) {
    const el = U.$('#pgOut');
    if (el) el.innerHTML = html;
  }

  function metaRows(info) {
    const rows = [];
    if (info.target) rows.push(U.kv('钉住目标', '<span class="mono">' + U.esc(info.target) + '</span>'));
    if (info.actual) rows.push(U.kv('实际渠道', '<strong class="mono">' + U.esc(info.actual) + '</strong>'));
    if (info.canonical) rows.push(U.kv('背后模型', '<span class="mono">' + U.esc(info.canonical) + '</span>'));
    if (info.attempts != null) rows.push(U.kv('尝试次数', U.esc(String(info.attempts))));
    if (info.account) rows.push(U.kv('账号', U.esc(info.account)));
    if (info.ms) rows.push(U.kv('耗时', U.esc(U.fmtMs(info.ms))));
    return rows.join('');
  }

  async function send(root) {
    const model = U.$('#pgModel').value.trim();
    const prompt = U.$('#pgPrompt').value;
    const max = Number(U.$('#pgMax').value) || 256;
    if (!model) return U.toast('请填写模型 ID', 'err');
    if (!window.APP.engine.ok) return U.toast('代理服务未运行', 'err');

    const btn = U.$('[data-act="send"]', root);
    btn.disabled = true; btn.textContent = '发送中…';
    renderOut('<span class="muted">请求中…</span>');
    try {
      const r = await window.cp.proxy.chat({ model, prompt, maxTokens: max });
      lastRaw = r;
      const u = r.usage || {};
      const body = (r.content != null && r.content !== '')
        ? '<div class="mono" style="background:var(--surface-2);border:1px solid var(--hairline);border-radius:7px;padding:10px;user-select:text;white-space:pre-wrap;max-height:320px;overflow:auto">' + U.esc(r.content) + '</div>'
        : '<div class="muted">（空回复）</div>';
      renderOut(
        '<div class="badge ' + (r.status === 200 ? 'b-good' : 'b-critical') + '" style="margin-bottom:10px">' +
          '<span class="b-ico">' + (r.status === 200 ? '✔' : '✘') + '</span>HTTP ' + r.status + '</div>' +
        metaRows({ target: r.headers['x-cline-target-upstream'], actual: r.headers['x-cline-actual-upstream'],
                   canonical: r.headers['x-cline-canonical-model'], attempts: r.headers['x-cline-attempts'],
                   account: r.headers['x-cline-account'], ms: r.ms }) +
        (u.total_tokens != null ? U.kv('用量', U.esc(u.prompt_tokens + ' + ' + u.completion_tokens + ' = ' + u.total_tokens + ' tokens')) : '') +
        '<div class="field" style="margin-top:10px">' + body + '</div>' +
        (r.error ? '<div class="mono" style="color:var(--critical);margin-top:8px;user-select:text">' + U.esc(JSON.stringify(r.error)) + '</div>' : '') +
        '<div class="row-gap" style="margin-top:10px"><button class="btn btn-sm" data-act="raw">查看原始 JSON</button></div>'
      );
      const ms = U.$('#pgMs'); if (ms) ms.textContent = U.fmtMs(r.ms);
    } catch (e) {
      renderOut('<div class="badge b-critical"><span class="b-ico">✘</span>请求失败</div><div class="mono" style="margin-top:8px;color:var(--critical);user-select:text">' + U.esc(e.message) + '</div>');
    }
    btn.disabled = false; btn.textContent = '发送';
  }

  async function pincheck(root) {
    const model = U.$('#pgModel').value.trim();
    if (!model) return U.toast('请填写模型 ID', 'err');
    const btn = U.$('[data-act="pincheck"]', root);
    btn.disabled = true; btn.textContent = '验证中…';
    renderOut('<span class="muted">正在验证钉住是否被网关采纳…</span>');
    try {
      const cfgRes = await API.config();
      const cfg = (cfgRes.perModel || {})[model] || { upstreams: [], exclude: [] };
      const r = await API.test({ model, upstreams: cfg.upstreams || [], exclude: cfg.exclude || [] });
      const adopted = (cfg.upstreams || []).length && r.ok && (cfg.upstreams || []).includes(r.actual);
      renderOut(
        (r.ok
          ? '<div class="badge ' + ((cfg.upstreams || []).length ? (adopted ? 'b-good' : 'b-serious') : '') + '" style="margin-bottom:10px">' +
              '<span class="b-ico">' + (!(cfg.upstreams || []).length ? '·' : adopted ? '✔' : '⚠') + '</span>' +
              (!(cfg.upstreams || []).length ? '未配置钉住链（网关自选）' : adopted ? '网关采纳了钉住' : '网关未采纳，实际走了 ' + (r.actual || '未知')) + '</div>'
          : '<div class="badge b-critical" style="margin-bottom:10px"><span class="b-ico">✘</span>请求失败</div>') +
        U.kv('配置链', (cfg.upstreams || []).length ? '<span class="mono">' + cfg.upstreams.map(U.esc).join(' → ') + '</span>' : '<span class="muted">自动</span>') +
        metaRows({ actual: r.actual, canonical: r.canonicalSlug, ms: r.ms, account: r.account }) +
        (r.trace ? U.kv('尝试路径', U.attemptPath(r.trace)) : '') +
        (r.content ? '<div class="field" style="margin-top:10px"><div class="mono" style="background:var(--surface-2);border:1px solid var(--hairline);border-radius:7px;padding:10px;user-select:text">' + U.esc(r.content) + '</div></div>' : '') +
        (r.error ? '<div class="mono" style="color:var(--critical);margin-top:8px;user-select:text">' + U.esc(r.error) + '</div>' : '')
      );
    } catch (e) {
      renderOut('<div class="mono" style="color:var(--critical);user-select:text">' + U.esc(e.message) + '</div>');
    }
    btn.disabled = false; btn.textContent = '钉住验证';
  }

  function wire(root) {
    U.delegate(root, 'click', '[data-act]', (e, el) => {
      const act = el.getAttribute('data-act');
      if (act === 'send') return send(root);
      if (act === 'pincheck') return pincheck(root);
      if (act === 'raw') {
        return U.modal({
          title: '原始响应 JSON',
          width: 720,
          bodyHTML: '<pre class="mono" style="white-space:pre-wrap;user-select:text;margin:0">' + U.esc(JSON.stringify(lastRaw && lastRaw.json, null, 2)) + '</pre>',
          confirmLabel: '', cancelLabel: '关闭',
        });
      }
      void e;
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.playground = {
    title: '测试台',
    sub: () => '走真实代理链路验证模型与上游钉住',
    actions: () => '<button class="btn btn-sm" data-act="refresh">重新读取</button>',
    async load(root) { models = []; await load(root); },
    async onAction(act) { if (act === 'refresh') { await window.APP.refresh(); window.APP.renderCurrent(); } },
  };
})();
