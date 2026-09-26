// 设置：代理服务、访问与安全、桌面应用行为、数据管理、运行日志
(function () {
  'use strict';

  let sec = { proxyKey: '', publicBaseUrl: '', exposeCatalog: false };
  let appSettings = {};
  let boot = null;

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    boot = window.APP.boot;
    appSettings = await window.cp.settings.get();
    try { sec = await API.security(); } catch { /* 引擎未运行 */ }
    render(root);
  }

  function render(root) {
    const e = window.APP.engine;
    root.innerHTML = [
      renderService(e),
      renderSecurity(),
      renderDesktop(),
      renderData(),
    ].join('');
  }

  function renderService(e) {
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">代理服务</div>' +
        '<div>' + (e.ok
          ? U.statusBadge('ok', '运行中 · 127.0.0.1:' + e.port)
          : U.statusBadge('bad', '已停止')) + '</div></div>' +
      (e.error ? '<div class="banner b-critical"><span class="b-ico">⚠</span><div>' + U.esc(e.error) + '</div></div>' : '') +
      '<div class="grid-2">' +
        '<div class="field"><label class="field-label">监听端口</label>' +
          '<input class="input" id="setPort" type="number" min="1" max="65535" value="' + U.esc(String((boot.config && boot.config.port) || 3123)) + '">' +
          '<div class="field-hint">下游客户端把 Base URL 指向 <span class="mono">http://127.0.0.1:端口/v1</span>。改端口后需重启服务。</div></div>' +
        '<div class="field"><label class="field-label">上游网关</label>' +
          '<input class="input mono" value="' + U.esc('https://api.cline.bot/api/v1') + '" disabled>' +
          '<div class="field-hint">Cline Pass 官方网关（config.json 的 upstreamBase）。</div></div>' +
      '</div>' +
      '<div class="row-gap">' +
        '<button class="btn btn-primary" data-act="save-port">保存端口</button>' +
        '<button class="btn" data-act="restart">重启服务</button>' +
        (e.ok
          ? '<button class="btn" data-act="stop">停止服务</button>'
          : '<button class="btn btn-primary" data-act="start">启动服务</button>') +
        (e.ok ? '<button class="btn btn-ghost" data-act="copy-base">复制代理地址</button>' : '') +
      '</div>' +
    '</div>';
  }

  function renderSecurity() {
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">访问与安全</div>' +
        '<div class="card-note">下游客户端访问代理所需的凭据</div></div>' +
      '<div class="field"><label class="field-label">下游代理密钥（proxyKey）</label>' +
        '<div class="inline">' +
          '<input class="input mono" id="setProxyKey" value="' + U.esc(sec.proxyKey || '') + '" placeholder="留空 = 不鉴权（仅本机可用时推荐）" spellcheck="false">' +
          '<button class="btn btn-sm" data-act="gen-key">随机生成</button>' +
        '</div>' +
        '<div class="field-hint">设置后，<span class="mono">/v1/*</span> 与 <span class="mono">/api/*</span> 都要求 <span class="mono">Authorization: Bearer &lt;key&gt;</span>。对外暴露务必设置。</div></div>' +
      '<div class="field"><label class="field-label">公网代理地址（publicBaseUrl）</label>' +
        '<input class="input mono" id="setPublicBase" value="' + U.esc(sec.publicBaseUrl || '') + '" placeholder="https://pass.example.com" spellcheck="false">' +
        '<div class="field-hint">仅用于界面展示，方便把地址发给其他设备上的客户端。注意：内嵌服务只监听 127.0.0.1，需要外网访问请自行加反向代理。</div></div>' +
      '<label class="switch"><input type="checkbox" id="setExposeCatalog" ' + (sec.exposeCatalog ? 'checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">对外暴露完整目录（exposeCatalog）—— 默认只暴露订阅模型，避免客户端模型列表被淹没</span></label>' +
      '<div class="row-gap" style="margin-top:10px">' +
        '<button class="btn btn-primary" data-act="save-security">保存</button>' +
        '<button class="btn" data-act="rotate-key">轮换并复制新密钥</button>' +
      '</div>' +
    '</div>';
  }

  function renderDesktop() {
    const langMode = (window.I18N && window.I18N.mode) || 'auto';
    const sysLang = (window.I18N && window.I18N.detectSystem()) || 'zh';
    const opt = (v, label) => '<option value="' + v + '"' + (langMode === v ? ' selected' : '') + '>' + U.esc(label) + '</option>';
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">桌面应用</div>' +
        '<div class="card-note">本机行为，不影响代理</div></div>' +
      '<label class="switch"><input type="checkbox" id="setAutoLaunch" ' + (appSettings.autoLaunch ? 'checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">开机自动启动（后台常驻，不弹窗）</span></label>' +
      '<label class="switch"><input type="checkbox" id="setCloseToTray" ' + (appSettings.closeToTray ? 'checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">点关闭时最小化到托盘（代理继续运行）</span></label>' +
      '<label class="switch"><input type="checkbox" id="setMinToTray" ' + (appSettings.minimizeToTray ? 'checked' : '') + '><span class="track"></span>' +
        '<span class="switch-label">点最小化时隐藏到托盘</span></label>' +
      '<div class="field-hint" style="margin-top:8px">关掉「关闭到托盘」后，点窗口右上角关闭按钮会同时退出代理（托盘图标也随之消失）。</div>' +
      // 界面语言：默认跟随系统，可手动指定
      '<div class="field" style="margin-top:14px;max-width:340px">' +
        '<label class="field-label">界面语言</label>' +
        '<select class="select" id="setLang">' +
          opt('auto', '跟随系统（当前：' + (sysLang === 'zh' ? '中文' : 'English') + '）') +
          opt('zh', '中文') +
          opt('en', 'English') +
        '</select>' +
        '<div class="field-hint">切换后立即生效，并会记住选择。界面语言不影响模型回复的语言。</div>' +
      '</div>' +
    '</div>';
  }

  function renderData() {
    return '<div class="card">' +
      '<div class="card-head"><div class="card-title">数据</div>' +
        '<div class="card-note">配置与学习结果都保存在本机数据目录</div></div>' +
      U.kv('数据目录', '<span class="mono" style="user-select:text">' + U.esc(boot.dataDir || '') + '</span>' +
        ' <button class="btn btn-ghost btn-sm" data-act="open-data">打开</button>') +
      U.kv('配置文件', '<span class="mono">config.json</span>（含明文密钥，请勿分享）') +
      U.kv('学习结果', '<span class="mono">metadata.json</span>（渠道清单、状态、请求历史）') +
      '<div class="row-gap" style="margin-top:10px">' +
        '<button class="btn" data-act="claudecfg">写入 Claude Code 配置</button>' +
        '<button class="btn" data-act="ccswitch">导入到 CC Switch</button>' +
        '<button class="btn" data-act="export">导出配置</button>' +
        '<button class="btn" data-act="import">导入配置</button>' +
        '<button class="btn" data-act="show-logs">查看运行日志</button>' +
      '</div>' +
    '</div>';
  }

  function randKey() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return 'sk-cc-' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  function wire(root) {
    U.delegate(root, 'click', '[data-act]', async (e, el) => {
      const act = el.getAttribute('data-act');
      try {
        if (act === 'save-port') {
          const port = Number(U.$('#setPort').value);
          if (!port || port < 1 || port > 65535) return U.toast('端口不合法', 'err');
          const r = await window.cp.config.patch({ port });
          API.setPort(r.config.port);
          if (r.needsRestart) {
            if (await U.confirm('端口已改', '端口已写入配置，需要重启服务才会生效。现在重启？', '立即重启')) {
              const rr = await window.cp.engine.restart({ port: r.config.port });
              API.setPort(rr.ok ? rr.port : r.config.port);
              U.toast(rr.ok ? '服务已在新端口启动' : ('重启失败：' + rr.error), rr.ok ? 'ok' : 'err');
            }
          } else U.toast('端口已保存', 'ok');
          await window.APP.refresh(); window.APP.renderCurrent();
        } else if (act === 'restart') {
          const port = Number(U.$('#setPort').value) || undefined;
          el.disabled = true; el.textContent = '重启中…';
          const r = await window.cp.engine.restart(port ? { port } : {});
          API.setPort(r.ok ? r.port : port);
          U.toast(r.ok ? '服务已重启' : ('重启失败：' + r.error), r.ok ? 'ok' : 'err');
          await window.APP.refresh(); window.APP.renderCurrent();
        } else if (act === 'stop') {
          await window.cp.engine.stop();
          U.toast('服务已停止', 'ok');
          await window.APP.refresh(); window.APP.renderCurrent();
        } else if (act === 'start') {
          const port = Number(U.$('#setPort').value) || undefined;
          const r = await window.cp.engine.start(port ? { port } : {});
          if (r.ok) API.setPort(r.port);
          U.toast(r.ok ? '服务已启动' : ('启动失败：' + r.error), r.ok ? 'ok' : 'err');
          await window.APP.refresh(); window.APP.renderCurrent();
        } else if (act === 'copy-base') {
          U.copy('http://127.0.0.1:' + window.APP.engine.port + '/v1', '代理地址已复制');
        } else if (act === 'gen-key' || act === 'rotate-key') {
          // 只填进输入框；「轮换」额外直接落盘并把新密钥复制走
          const key = randKey();
          U.$('#setProxyKey').value = key;
          if (act === 'rotate-key') {
            const saved = await API.saveSecurity({
              proxyKey: key,
              publicBaseUrl: U.$('#setPublicBase').value.trim(),
              exposeCatalog: U.$('#setExposeCatalog').checked,
            });
            API.setProxyKey(saved.proxyKey);
            sec = saved;
            await U.copy(saved.proxyKey, '新密钥已保存并复制');
            await window.APP.refresh();
            render(root); wire(root);
          }
        } else if (act === 'save-security') {
          const payload = {
            proxyKey: U.$('#setProxyKey').value.trim(),
            publicBaseUrl: U.$('#setPublicBase').value.trim(),
            exposeCatalog: U.$('#setExposeCatalog').checked,
          };
          const saved = await API.saveSecurity(payload);
          API.setProxyKey(saved.proxyKey);
          sec = saved;
          U.toast(saved.authRequired ? '已保存，代理已开启鉴权' : '已保存，代理免鉴权', 'ok');
          await window.APP.refresh();
          render(root); wire(root);
        } else if (act === 'claudecfg') {
          window.CLAUDECFG.open();
        } else if (act === 'ccswitch') {
          window.CCSWITCH.open();
        } else if (act === 'open-data') {
          await window.cp.app.openDataDir();
        } else if (act === 'export') {
          const r = await window.cp.config.exportFile();
          if (r.ok) U.toast('已导出到 ' + r.filePath, 'ok');
          else if (!r.canceled) U.toast('导出失败：' + (r.error || ''), 'err');
        } else if (act === 'import') {
          const r = await window.cp.config.importFile();
          if (r.ok) {
            U.toast('已导入配置' + (r.needsRestart ? '，端口变化需重启服务' : ''), 'ok');
            await window.APP.refresh(); window.APP.renderCurrent();
          } else if (!r.canceled) U.toast(r.error || '导入失败', 'err');
        } else if (act === 'show-logs') {
          window.APP.toggleLogs(true);
        }
      } catch (err) {
        U.toast(err.message || String(err), 'err');
      }
      void e;
    });

    for (const [id, key] of [['setAutoLaunch', 'autoLaunch'], ['setCloseToTray', 'closeToTray'], ['setMinToTray', 'minimizeToTray']]) {
      const el = U.$('#' + id, root);
      if (el) U.on(el, 'change', async () => {
        appSettings = await window.cp.settings.set({ [key]: el.checked });
        U.toast('已' + (el.checked ? '开启' : '关闭'), 'ok');
      });
    }

    // 界面语言。切换会整页重载（原因见 i18n.js 的 setMode），
    // 所以这里只需存好选择 —— 重载后 boot() 会读它。
    const langEl = U.$('#setLang', root);
    if (langEl) U.on(langEl, 'change', async () => {
      await window.cp.settings.set({ language: langEl.value });
      U.toast(langEl.value === 'zh' ? '界面语言已切换为中文' : 'Interface language set to English', 'ok');
      window.I18N.setMode(langEl.value);
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.settings = {
    title: '设置',
    sub: () => '代理服务、访问密钥、桌面行为与数据管理',
    actions: () => '',
    async load(root) { await load(root); wire(root); },
    async onAction() { /* 由 app 顶部按钮统一处理 */ },
  };
})();
