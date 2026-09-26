// 一键把本机代理写进 Claude Code 的 ~/.claude/settings.json
//
// 与「导入到 CC Switch」的区别：那条路要经 cc-switch 中转（它是中间人，也是它去写这个文件）；
// 这里直接把环境变量写进 Claude Code 的全局配置，Claude Code 就直连本机代理。
//
// 风险控制全在主进程的 claude-config.js 里（只动自己的键、写前备份、非法 JSON 拒绝写入、
// 支持从备份还原）。这个文件只负责把「将要发生什么」讲清楚，再让用户点确认。
(function () {
  'use strict';

  let STATE = null;

  function localBase() {
    const b = (window.APP.boot && window.APP.boot.proxyBase) || '';
    if (b) return b.replace(/\/+$/, '').replace(/\/v1$/, '');
    const port = (window.APP.engine && window.APP.engine.port) || '';
    return 'http://127.0.0.1:' + port;
  }
  const stripV1 = (s) => String(s || '').replace(/\/+$/, '').replace(/\/v1$/, '');

  const mono = (s) => '<span class="mono" style="user-select:text">' + U.esc(s) + '</span>';

  // 翻译运行时拼出来的整句。中文界面下 T 直接返回原文，所以这里可以无脑调用。
  const tr = (s, vars) => (window.T ? window.T(s, vars) : s);

  // 把字节数说成人话：1000000 → 1M，1048576 → 1M，200000 → 200K。
  // 用 1024 进制判断、按 1000 进制进位 —— 1,048,576 和 1,000,000 都是「1M」，
  // 用户不需要知道上游给的是哪种口径。
  function fmtCtx(n) {
    const v = Number(n) || 0;
    if (v >= 1e6) return (v / 1e6).toFixed(v % 1e6 === 0 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (v >= 1000) return Math.round(v / 1000) + 'K';
    return String(v);
  }

  async function open() {
    const engine = window.APP.engine || {};
    if (!engine.ok) { U.toast('代理服务未运行：先在「设置」里启动服务，再来写配置', 'err'); return; }

    const cfg = (window.APP.boot && window.APP.boot.config) || {};
    const info = await window.cp.claude.info();

    const proxyKey = cfg.proxyKey || '';
    const publicBase = String(cfg.publicBaseUrl || '').trim();
    // 选项文字整句走翻译：DOM 走查是按整个文本节点查表的，
    // 「本机 · http://127.0.0.1:3123」这种拼出来的整串在词典里找不到。
    const baseChoices = [{ label: tr('本机 · {url}', { url: localBase() }), value: localBase() }];
    if (publicBase) baseChoices.push({ label: tr('公网 · {url}', { url: stripV1(publicBase) }), value: stripV1(publicBase) });

    const models = (window.APP.models || []).map((m) => m.id);
    const DEFAULT_MODEL = 'cline-pass/deepseek-v4.1-flash';
    if (!models.length) models.push(DEFAULT_MODEL);
    const pickModel = (list) => (list.indexOf(DEFAULT_MODEL) >= 0 ? DEFAULT_MODEL : list[0]);

    const ctxOptions = info.contextOptions || [
      { value: 200000, label: '200K（Claude Code 默认）' },
      { value: 1000000, label: '1M' },
    ];
    const ctxOf = (m) => Number((info.modelContexts || {})[m]) || 0;
    const DEF_CTX = info.defaultContextTokens || 200000;
    // 上次写过的窗口优先，其次看这个模型够不够 1M
    const initialCtx = info.currentContextTokens
      || (ctxOf(pickModel(models)) >= 1e6 ? 1000000 : DEF_CTX);

    STATE = {
      baseUrl: baseChoices[0].value,
      model: pickModel(models),
      token: proxyKey || 'local-proxy-no-key',
      hasProxyKey: !!proxyKey,
      info,
      models,
      contextTokens: initialCtx,
      preview: null,
    };

    function warnings() {
      const out = [];
      if (!info.valid) {
        out.push('<div class="banner b-critical"><span class="b-ico">✕</span><div>' +
          U.esc(tr('不能写入。{path} 现在{err}。我们不会去猜着修它 —— 先把它改回合法 JSON，或者手动编辑，再回来。',
            { path: info.path, err: info.error || '无法解析' })) +
          '</div></div>');
      }
      if (info.valid && info.looksProxyManaged) {
        // 供应商名与当前 base url 是用户数据，不翻译；句子其余部分整句走词典。
        out.push('<div class="banner b-warning"><span class="b-ico">⚠</span><div>' +
          U.esc(tr('这个文件看起来正被某个供应商切换器管理（当前 ANTHROPIC_BASE_URL = {url}，指向本机端口）。在那边切换供应商时它会重写这个文件，我们写的会被覆盖掉。两者选一个用：要么用这边的直连、要么继续走那边的中转。',
            { url: info.currentBaseUrl || '' })) +
          '</div></div>');
      }
      return out.join('');
    }

    const pathLine = info.exists
      ? '<div class="field-hint" style="margin:0 0 10px">' + U.esc(tr('目标文件：{path}（已存在，{n} 个环境变量{bak}）',
          { path: info.path, n: info.envCount, bak: info.backups ? tr('，有 {n} 份备份', { n: info.backups }) : '' })) + '</div>'
      : '<div class="field-hint" style="margin:0 0 10px">' + U.esc(tr('目标文件：{path}（还不存在，会新建）', { path: info.path })) + '</div>';

    const body = [
      warnings(),
      pathLine,
      '<div class="grid-2">',
        '<div class="field"><label class="field-label">代理地址</label>' +
          '<select class="select" id="ccBase">' +
            baseChoices.map((c) => '<option value="' + U.esc(c.value) + '">' + U.esc(c.label) + '</option>').join('') +
          '</select></div>',
        '<div class="field"><label class="field-label">默认模型</label>' +
          '<select class="select" id="ccModel">' +
            models.map((m) => '<option value="' + U.esc(m) + '"' + (m === STATE.model ? ' selected' : '') + '>' + U.esc(m) + '</option>').join('') +
          '</select></div>',
      '</div>',
      '<div class="field-hint" style="margin:-4px 0 12px">' +
        U.esc((window.T ? window.T : (s) => s)('Haiku / Sonnet / Opus / Fable 与子代理全部映射到这同一个模型，Claude Code 里怎么切都不会漏回 Anthropic 官方。')) +
      '</div>',
      '<div class="field"><label class="field-label">上下文窗口</label>' +
        '<div class="seg" id="ccCtx" role="radiogroup">' +
          ctxOptions.map((o) => '<button type="button" class="seg-btn' +
            (Number(o.value) === Number(STATE.contextTokens) ? ' is-active' : '') +
            '" role="radio" aria-checked="' + (Number(o.value) === Number(STATE.contextTokens)) +
            '" data-ctx="' + U.esc(o.value) + '">' + U.esc(o.label) + '</button>').join('') +
        '</div>' +
        '<div class="field-hint" id="ccCtxHint" style="margin-top:6px"></div>' +
      '</div>',
      '<div class="field"><label class="field-label">写入的环境变量</label><div id="ccPrev"></div></div>',
      '<div class="field-hint" style="margin-top:10px">' + (STATE.hasProxyKey
        ? '代理密钥会<b>以明文</b>写进这个文件。以后在「设置 → 访问与安全」里轮换密钥时，记得回来重新写一次，否则 Claude Code 会拿到旧密钥被拒。'
        : '本机代理没有设密钥（免鉴权），这里填占位符 <span class="mono">local-proxy-no-key</span> —— 代理不校验它。想要真密钥就到「设置 → 访问与安全」生成一个，再回来写。') +
      '</div>',
      '<div class="field-hint" style="margin-top:6px">' +
        U.esc(tr('写完后需要重启 Claude Code（或新开一个会话）才生效。')) + '</div>',
    ].join('');

    const m = U.modal({
      title: '写入 Claude Code 配置',
      bodyHTML: body,
      width: 780,
      confirmLabel: info.valid ? '写入配置' : '无法写入',
      cancelLabel: '关闭',
      onConfirm: () => doWrite(),
    });
    const root = m.root;

    // 底部左侧：打开所在文件夹 / 从备份还原
    const foot = U.$('.modal-foot', root);
    if (foot) {
      foot.insertAdjacentHTML('afterbegin',
        '<button class="btn btn-ghost" data-reveal style="margin-right:auto">打开所在文件夹</button>' +
        (info.backups ? '<button class="btn btn-ghost" data-restore style="margin-right:8px">从备份还原</button>' : ''));
    }
    U.delegate(root, 'click', '[data-reveal]', () => window.cp.claude.reveal());
    U.delegate(root, 'click', '[data-restore]', async (e, el) => {
      el.disabled = true;
      const r = await window.cp.claude.restore();
      el.disabled = false;
      U.toast(r.ok ? '已还原（备份：' + (r.restoredFrom || '').split(/[\\/]/).pop() + '）' : '还原失败：' + r.error, r.ok ? 'ok' : 'err');
      if (r.ok) { m.close(); }
    });

    // 上下文窗口那一行的提示：说清楚这个模型实测多大、写 1M 有没有依据。
    // 上游不返回窗口数据时明说「未知」，不假装 1M 一定可用。
    //
    // 整句交给 T() 翻，不要用「HTML 片段 + 多段拼接」：DOM 走查是按文本节点翻的，
    // 被 <b> 切开后每段都成了独立文本节点，词典里根本对不上 —— 中文界面看不出问题，
    // 切成英文就会留下半句中文。带变量的一律走 {n} 占位。
    function paintCtxHint() {
      const box = U.$('#ccCtxHint', root);
      if (!box) return;
      const known = ctxOf(STATE.model);
      const chosen = STATE.contextTokens;
      const arch = tr('上游渠道支持更大的窗口时，Claude Code 认不出这个模型名就会按 200K 假设，在 20 万 token 处提前触发自动压缩；写这个值就是告诉它真实的窗口有多大。要写比默认档更大的值才会落键，默认档不写。');

      let line;
      if (!known) {
        line = tr('这个模型的上下文窗口还没有探测数据（到「模型」页探测一次即可拿到）。不确定就别写：写大了而实际上游更小，请求会直接失败。');
      } else if (chosen > known) {
        line = tr('⚠ 你选的 {a} 大于实测的 {b}，超出的部分会被上游拒绝，建议改回 {b} 或更小。',
          { a: fmtCtx(chosen), b: fmtCtx(known) });
      } else if (chosen > DEF_CTX) {
        line = tr('实测这个模型最大 {n}，写 {m} 在范围内。', { n: fmtCtx(known), m: fmtCtx(chosen) });
      } else {
        line = known
          ? tr('按默认 200K 走，不写入这个键（实测这个模型有 {n}）。', { n: fmtCtx(known) })
          : tr('按默认 200K 走，不写入这个键。');
      }
      box.textContent = line + ' ' + arch;
    }

    async function refreshPreview() {
      const p = await window.cp.claude.preview({ baseUrl: STATE.baseUrl, token: STATE.token, model: STATE.model, contextTokens: STATE.contextTokens });
      STATE.preview = p;
      const box = U.$('#ccPrev', root);
      if (!box) return;
      if (!p.ok) { box.innerHTML = '<div class="empty">' + U.esc(p.error) + '</div>'; return; }

      const added = new Set(p.added);
      const changed = new Set(p.changed);
      const removed = new Set(p.removed || []);
      const before = {};
      for (const d of p.diffs || []) before[d.key] = d.from;
      const removedBefore = {};
      for (const d of p.removedDiffs || []) removedBefore[d.key] = d.from;

      // 一句话汇总：先说清楚总共会动多少、保留多少。
      //
      // 整句走 T()，不要用「HTML 片段 + 拼接」：DOM 走查是按文本节点翻的，被 <b>/<span>
      // 切开后每段都是独立文本节点，词典里对不上 —— 中文界面看不出来，切英文就留半句中文。
      // 要着色/加粗的**数字**单独包一层（数字本身不需要翻译），文字部分必须是完整句子。
      const nRemoved = (p.removed || []).length;
      const kept = p.keptTopLevel || [];
      const nEnv = Object.keys(p.env).length;
      const summaryText = p.exists
        ? tr('本次会写入 {n} 个环境变量：新增 {a}、覆盖 {c}、不变 {s}。', {
            n: nEnv, a: p.added.length, c: p.changed.length, s: p.same.length,
          }) +
          (nRemoved ? tr('另有 {n} 个键会被删除。', { n: nRemoved }) : '') +
          tr('文件里另外 {n} 个顶层键与无关的环境变量一律原样保留，不会被覆盖。', { n: kept.length })
        : tr('目标文件还不存在，会新建一个，只含下面这些环境变量。');
      const summary = '<div class="field-hint" style="margin:0 0 8px">' + U.esc(summaryText) +
        (p.exists && kept.length
          ? '<br><span class="mono" style="font-size:11px">' + U.esc(kept.join('、')) + '</span>'
          : '') +
        '</div>';

      const list = '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
        Object.entries(p.env).map(([k, v]) => {
          const badge = added.has(k) ? '<span class="badge b-good" style="margin-left:6px">新增</span>'
            : changed.has(k) ? '<span class="badge b-warning" style="margin-left:6px">覆盖</span>'
            : '<span class="badge" style="margin-left:6px">不变</span>';
          const old = changed.has(k) && before[k] != null
            ? '<div class="field-hint" style="margin:2px 0 0">' + U.esc(tr('原值 {v}', { v: String(before[k]) })) + '</div>' : '';
          return '<div style="padding:7px 10px;border-bottom:1px solid var(--border)">' +
            '<div style="font-size:12px"><span class="mono">' + U.esc(k) + '</span>' + badge + '</div>' +
            '<div style="font-size:12px;margin-top:2px">' + mono(v) + '</div>' +
            old + '</div>';
        }).join('') +
        // 被删的键也要列出来，否则「换回 200K 会把 1M 那行删掉」用户根本看不见
        [...removed].map((k) =>
          '<div style="padding:7px 10px;border-bottom:1px solid var(--border);background:var(--critical-soft)">' +
          '<div style="font-size:12px"><span class="mono">' + U.esc(k) + '</span>' +
          '<span class="badge b-critical" style="margin-left:6px">' + U.esc(tr('将被删除')) + '</span></div>' +
          (removedBefore[k] != null
            ? '<div class="field-hint" style="margin:2px 0 0">' + U.esc(tr('原值 {v}', { v: String(removedBefore[k]) })) + '</div>' : '') +
          '</div>').join('') +
        '</div>';

      // 完整文件内容：密钥打码（我们写的那几个键的明文在上面的列表里已经有了）
      const masked = p.result
        ? JSON.stringify(p.result, (k, v) => (typeof v === 'string' && /TOKEN|KEY|SECRET/i.test(k) ? '***' : v), 2)
        : '';
      const full = masked
        ? '<details style="margin-top:10px"><summary style="cursor:pointer;font-size:12px;color:var(--ink-2)">' +
          '展开预览写入后的完整文件内容（密钥打码）</summary>' +
          '<pre class="mono" style="margin-top:8px;max-height:220px;overflow:auto;font-size:11.5px;line-height:1.6;' +
          'background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:10px;white-space:pre">' +
          U.esc(masked) + '</pre></details>'
        : '';

      box.innerHTML = summary + list + full;
    }

    U.delegate(root, 'click', '#ccCtx .seg-btn', (_e, el) => {
      STATE.contextTokens = Number(el.getAttribute('data-ctx'));
      for (const b of U.$$('#ccCtx .seg-btn', root)) {
        const on = Number(b.getAttribute('data-ctx')) === STATE.contextTokens;
        b.classList.toggle('is-active', on);
        b.setAttribute('aria-checked', String(on));
      }
      paintCtxHint();
      refreshPreview();
    });
    U.delegate(root, 'change', '#ccBase', (_e, el) => { STATE.baseUrl = el.value; refreshPreview(); });
    U.delegate(root, 'change', '#ccModel', (_e, el) => { STATE.model = el.value; paintCtxHint(); refreshPreview(); });
    paintCtxHint();
    await refreshPreview();

    async function doWrite() {
      if (!STATE.info.valid) { U.toast('目标文件不是合法 JSON，已放弃写入', 'err'); return false; }
      const r = await window.cp.claude.write({ baseUrl: STATE.baseUrl, token: STATE.token, model: STATE.model, contextTokens: STATE.contextTokens });
      if (!r.ok) { U.toast('写入失败：' + r.error, 'err'); return false; }
      U.toast('已写入 ' + r.path + (r.backupPath ? '（备份 ' + r.backupPath.split(/[\\/]/).pop() + '）' : ''), 'ok');
      return true;
    }
  }

  window.CLAUDECFG = { open };
})();
