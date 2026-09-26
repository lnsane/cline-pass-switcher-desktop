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

  async function open() {
    const engine = window.APP.engine || {};
    if (!engine.ok) { U.toast('代理服务未运行：先在「设置」里启动服务，再来写配置', 'err'); return; }

    const cfg = (window.APP.boot && window.APP.boot.config) || {};
    const info = await window.cp.claude.info();

    const proxyKey = cfg.proxyKey || '';
    const publicBase = String(cfg.publicBaseUrl || '').trim();
    const baseChoices = [{ label: '本机 · ' + localBase(), value: localBase() }];
    if (publicBase) baseChoices.push({ label: '公网 · ' + stripV1(publicBase), value: stripV1(publicBase) });

    const models = (window.APP.models || []).map((m) => m.id);
    const DEFAULT_MODEL = 'cline-pass/deepseek-v4.1-flash';
    if (!models.length) models.push(DEFAULT_MODEL);
    const pickModel = (list) => (list.indexOf(DEFAULT_MODEL) >= 0 ? DEFAULT_MODEL : list[0]);

    STATE = {
      baseUrl: baseChoices[0].value,
      model: pickModel(models),
      token: proxyKey || 'local-proxy-no-key',
      hasProxyKey: !!proxyKey,
      info,
      models,
      preview: null,
    };

    function warnings() {
      const out = [];
      if (!info.valid) {
        out.push('<div class="banner b-critical"><span class="b-ico">✕</span><div><b>不能写入。</b>' +
          U.esc(info.path) + ' 现在' + U.esc(info.error || '无法解析') +
          '。我们不会去猜着修它 —— 先把它改回合法 JSON，或者手动编辑，再回来。</div></div>');
      }
      if (info.valid && info.looksProxyManaged) {
        out.push('<div class="banner b-warning"><span class="b-ico">⚠</span><div>' +
          '这个文件看起来<b>正被某个供应商切换器管理</b>（当前 <span class="mono">ANTHROPIC_BASE_URL</span> = ' +
          mono(info.currentBaseUrl || '') + '，指向本机端口）。' +
          '在那边切换供应商时它会重写这个文件，<b>我们写的会被覆盖掉</b>。' +
          '两者选一个用：要么用这边的直连、要么继续走那边的中转。</div></div>');
      }
      return out.join('');
    }

    const pathLine = info.exists
      ? '<div class="field-hint" style="margin:0 0 10px">目标文件：' + mono(info.path) +
        '（已存在，' + info.envCount + ' 个环境变量' +
        (info.backups ? '，有 ' + info.backups + ' 份备份' : '') + '）</div>'
      : '<div class="field-hint" style="margin:0 0 10px">目标文件：' + mono(info.path) + '（还不存在，会新建）</div>';

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
      '<div class="field-hint" style="margin:-4px 0 12px">Haiku / Sonnet / Opus / Fable 与子代理全部映射到这同一个模型，' +
        'Claude Code 里怎么切都不会漏回 Anthropic 官方。</div>',
      '<div class="field"><label class="field-label">写入的环境变量</label><div id="ccPrev"></div></div>',
      '<div class="field-hint" style="margin-top:10px">' + (STATE.hasProxyKey
        ? '代理密钥会<b>以明文</b>写进这个文件。以后在「设置 → 访问与安全」里轮换密钥时，记得回来重新写一次，否则 Claude Code 会拿到旧密钥被拒。'
        : '本机代理没有设密钥（免鉴权），这里填占位符 <span class="mono">local-proxy-no-key</span> —— 代理不校验它。想要真密钥就到「设置 → 访问与安全」生成一个，再回来写。') +
      '</div>',
      '<div class="field-hint" style="margin-top:6px">写完后<b>需要重启 Claude Code</b>（或新开一个会话）才生效。</div>',
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

    async function refreshPreview() {
      const p = await window.cp.claude.preview({ baseUrl: STATE.baseUrl, token: STATE.token, model: STATE.model });
      STATE.preview = p;
      const box = U.$('#ccPrev', root);
      if (!box) return;
      if (!p.ok) { box.innerHTML = '<div class="empty">' + U.esc(p.error) + '</div>'; return; }

      const added = new Set(p.added);
      const changed = new Set(p.changed);
      const before = {};
      for (const d of p.diffs || []) before[d.key] = d.from;

      // 一句话汇总：先说清楚总共会动多少、保留多少
      const summary = '<div class="field-hint" style="margin:0 0 8px">' +
        (p.exists
          ? '本次会写入 <b>' + Object.keys(p.env).length + '</b> 个环境变量：' +
            '<span style="color:var(--good)">新增 ' + p.added.length + '</span>、' +
            '<span style="color:var(--warning)">覆盖 ' + p.changed.length + '</span>、' +
            '不变 ' + p.same.length + '。' +
            '文件里另外 <b>' + (p.keptTopLevel || []).length + '</b> 个顶层键' +
            ((p.keptTopLevel || []).length ? '（' + U.esc(p.keptTopLevel.join('、')) + '）' : '') +
            '与无关的环境变量一律原样保留，不会被覆盖。'
          : '目标文件还不存在，会新建一个，只含下面这些环境变量。') +
        '</div>';

      const list = '<div style="border:1px solid var(--border);border-radius:8px;overflow:hidden">' +
        Object.entries(p.env).map(([k, v]) => {
          const badge = added.has(k) ? '<span class="badge b-good" style="margin-left:6px">新增</span>'
            : changed.has(k) ? '<span class="badge b-warning" style="margin-left:6px">覆盖</span>'
            : '<span class="badge" style="margin-left:6px">不变</span>';
          const old = changed.has(k) && before[k] != null
            ? '<div class="field-hint" style="margin:2px 0 0">原值 <s>' + U.esc(before[k]) + '</s></div>' : '';
          return '<div style="padding:7px 10px;border-bottom:1px solid var(--border)">' +
            '<div style="font-size:12px"><span class="mono">' + U.esc(k) + '</span>' + badge + '</div>' +
            '<div style="font-size:12px;margin-top:2px">' + mono(v) + '</div>' +
            old + '</div>';
        }).join('') + '</div>';

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

    U.delegate(root, 'change', '#ccBase', (_e, el) => { STATE.baseUrl = el.value; refreshPreview(); });
    U.delegate(root, 'change', '#ccModel', (_e, el) => { STATE.model = el.value; refreshPreview(); });
    await refreshPreview();

    async function doWrite() {
      if (!STATE.info.valid) { U.toast('目标文件不是合法 JSON，已放弃写入', 'err'); return false; }
      const r = await window.cp.claude.write({ baseUrl: STATE.baseUrl, token: STATE.token, model: STATE.model });
      if (!r.ok) { U.toast('写入失败：' + r.error, 'err'); return false; }
      U.toast('已写入 ' + r.path + (r.backupPath ? '（备份 ' + r.backupPath.split(/[\\/]/).pop() + '）' : ''), 'ok');
      return true;
    }
  }

  window.CLAUDECFG = { open };
})();
