// 通用工具：DOM、格式化、提示、模态、徽标
(function () {
  'use strict';

  const U = {};

  // ---------- DOM ----------
  U.$ = (sel, root) => (root || document).querySelector(sel);
  U.$$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  U.esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  U.on = (el, ev, fn) => { if (el) el.addEventListener(ev, fn); return el; };

  // 事件委托：视图用 innerHTML 重绘，事件统一挂到容器上。
  // 容器是复用的（#view / 模态框），所以按 (事件, 选择器) 记账：重绘时重新绑定会覆盖旧处理器，
  // 同一 (事件, 选择器) 永远只有一个处理器，避免同一容器上累积监听导致一次点击触发多次。
  // 每种事件类型必须各挂一个监听：派发是跟着监听回调走的，没挂监听的事件类型
  // 整条链都到不了处理器（只挂首个事件类型时，后注册的 input/click 会全部静默失效）。
  const DELEGATES = new WeakMap();

  U.delegate = (root, ev, selector, handler) => {
    if (!root) return root;
    let byEvent = DELEGATES.get(root);
    if (!byEvent) { byEvent = new Map(); DELEGATES.set(root, byEvent); }
    let table = byEvent.get(ev);
    if (!table) {
      table = new Map();
      byEvent.set(ev, table);
      U.on(root, ev, (e) => {
        const bound = byEvent.get(ev);
        if (!bound || !bound.size) return;
        // 快照：处理器内部可能触发重绘并重新绑定
        for (const [sel, fn] of Array.from(bound)) {
          const target = e.target.closest(sel);
          if (target && root.contains(target)) fn(e, target);
        }
      });
    }
    table.set(selector, handler);
    return root;
  };

  // ---------- 格式化 ----------
  U.fmtMs = (ms) => {
    const n = Number(ms);
    if (!isFinite(n) || n <= 0) return '—';
    if (n < 1000) return Math.round(n) + ' ms';
    return (n / 1000).toFixed(n < 10000 ? 2 : 1) + ' s';
  };

  U.fmtInt = (n) => {
    const v = Number(n);
    return isFinite(v) ? v.toLocaleString('zh-CN') : '—';
  };

  U.fmtTime = (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  };

  U.timeAgo = (ts) => {
    if (!ts) return '从未';
    const s = Math.max(0, Math.floor((Date.now() - Number(ts)) / 1000));
    if (s < 60) return s + ' 秒前';
    const m = Math.floor(s / 60);
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const d = Math.floor(h / 24);
    if (d < 30) return d + ' 天前';
    return U.fmtTime(ts);
  };

  U.maskKey = (key) => {
    const k = String(key || '');
    if (k.length <= 14) return k ? '••••' : '（空）';
    return k.slice(0, 9) + '…' + k.slice(-4);
  };

  // ---------- 提示 ----------
  U.toast = (message, kind) => {
    const wrap = U.$('#toasts');
    if (!wrap) return;
    const node = document.createElement('div');
    node.className = 'toast ' + (kind === 'err' ? 'err' : kind === 'ok' ? 'ok' : '');
    const icon = kind === 'err' ? '⚠' : kind === 'ok' ? '✓' : '·';
    node.innerHTML = '<span class="b-ico">' + icon + '</span><span>' + U.esc(message) + '</span>';
    wrap.appendChild(node);
    setTimeout(() => node.remove(), kind === 'err' ? 6000 : 3000);
  };

  // ---------- 模态 ----------
  U.modal = ({ title, bodyHTML, confirmLabel = '确定', cancelLabel = '取消', danger = false, width, onConfirm }) => {
    const wrap = U.$('#modalWrap');
    wrap.hidden = false;
    wrap.innerHTML =
      '<div class="modal"' + (width ? ' style="max-width:' + Number(width) + 'px"' : '') + '>' +
        '<div class="modal-head">' + U.esc(title) + '</div>' +
        '<div class="modal-body">' + bodyHTML + '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn" data-act="cancel">' + U.esc(cancelLabel) + '</button>' +
          (confirmLabel ? '<button class="btn ' + (danger ? 'btn-danger' : 'btn-primary') + '" data-act="ok">' + U.esc(confirmLabel) + '</button>' : '') +
        '</div>' +
      '</div>';

    const close = () => { wrap.hidden = true; wrap.innerHTML = ''; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);

    U.on(U.$('[data-act="cancel"]', wrap), 'click', close);
    const okBtn = U.$('[data-act="ok"]', wrap);
    if (okBtn) {
      U.on(okBtn, 'click', async () => {
        if (onConfirm) {
          okBtn.disabled = true;
          try {
            const keep = await onConfirm(wrap);
            if (keep === false) { okBtn.disabled = false; return; }
          } catch (e) {
            U.toast(e.message || String(e), 'err');
            okBtn.disabled = false;
            return;
          }
        }
        close();
      });
    }
    wrap.onclick = (e) => { if (e.target === wrap) close(); };
    const first = U.$('input, textarea, select', wrap);
    if (first) setTimeout(() => first.focus(), 30);
    return { close, root: wrap };
  };

  U.confirm = (title, message, confirmLabel) => new Promise((resolve) => {
    U.modal({
      title,
      bodyHTML: '<div style="font-size:12.5px;line-height:1.7;color:var(--ink-2)">' + U.esc(message) + '</div>',
      confirmLabel: confirmLabel || '确定',
      danger: true,
      onConfirm: () => { resolve(true); },
    });
    // 取消 / 关闭路径：下一次打开时 resolve(false) 不会误触，这里用一次性兜底
    const wrap = U.$('#modalWrap');
    const obs = new MutationObserver(() => {
      if (wrap.hidden) { obs.disconnect(); resolve(false); }
    });
    obs.observe(wrap, { attributes: true, attributeFilter: ['hidden'] });
  });

  // ---------- 徽标 ----------
  const STATUS = {
    ok:        { ico: '✔', label: '可用',     cls: 'b-good' },
    limited:   { ico: '⏳', label: '限流',     cls: 'b-warning' },
    bad:       { ico: '✘', label: '不可钉',   cls: 'b-critical' },
    auth:      { ico: '⚿', label: '密钥问题', cls: 'b-serious' },
    unknown:   { ico: '?', label: '未测',     cls: '' },
  };
  U.STATUS = STATUS;

  // 状态永远是「图标 + 文字」成对出现，颜色只是辅助
  U.statusBadge = (status, extraLabel) => {
    const s = STATUS[status] || STATUS.unknown;
    return '<span class="badge ' + s.cls + '"><span class="b-ico">' + s.ico + '</span>' +
      U.esc(extraLabel || s.label) + '</span>';
  };

  U.pipelineBadge = (pipeline) => {
    if (pipeline === 'direct') return '<span class="badge b-series1"><span class="b-ico">◆</span>直连</span>';
    if (pipeline === 'planner') return '<span class="badge b-series2"><span class="b-ico">◆</span>规划器</span>';
    return '<span class="badge"><span class="b-ico">?</span>未探测</span>';
  };

  U.pinModeLabel = (m) => (m === 'preferred' ? '优先+回退' : '严格钉住');
  U.sortLabel = (s) => ({ cost: '最低成本', ttft: '最快首字', tps: '最高吞吐' }[s] || '网关默认');

  // ---------- 额度计量条 ----------
  // 单一比例值：数值本身是主通道，颜色按阈值分档（状态色，配合文字读数）
  U.meter = (pct, label, foot) => {
    const v = Math.max(0, Math.min(100, Number(pct) || 0));
    const tier = v >= 90 ? 's-critical' : v >= 70 ? 's-warning' : 's-good';
    return '<div class="meter">' +
      (label ? '<div class="meter-head"><span>' + U.esc(label) + '</span><span class="meter-val">' + v.toFixed(v < 10 ? 1 : 0) + '%</span></div>' : '') +
      '<div class="meter-track"><div class="meter-fill ' + tier + '" style="width:' + v + '%"></div></div>' +
      (foot ? '<div class="meter-foot">' + U.esc(foot) + '</div>' : '') +
    '</div>';
  };

  // ---------- 延迟条 ----------
  // 单序列量值：单一色相，只对显著偏慢的用状态色提示
  U.latCell = (ms) => {
    const n = Number(ms) || 0;
    const width = Math.max(2, Math.min(44, Math.round(n / 90)));
    const cls = n >= 30000 ? 'vslow' : n >= 10000 ? 'slow' : '';
    return '<div class="lat-cell"><div class="lat-bar ' + cls + '" style="width:' + width + 'px"></div>' +
      '<span class="lat-num">' + U.fmtMs(ms) + '</span></div>';
  };

  // 尝试路径：a(200) → b(502) → c(200)
  U.attemptPath = (trace, attempts) => {
    const list = Array.isArray(trace) && trace.length
      ? trace.map((t) => ({ name: t.upstream || 'auto', status: t.status }))
      : (attempts || []).map((a) => ({ name: a || 'auto', status: null }));
    if (!list.length) return '<span class="muted">自动</span>';
    return '<div class="attempt-path">' + list.map((t, i) => {
      const cls = t.status == null ? '' : t.status === 200 ? 'ok' : 'bad';
      const txt = U.esc(t.name) + (t.status == null ? '' : '(' + t.status + ')');
      return (i ? '<span class="chain-arrow">→</span>' : '') + '<span class="attempt-node ' + cls + '">' + txt + '</span>';
    }).join('') + '</div>';
  };

  // ---------- 其他 ----------
  U.copy = async (text, label) => {
    try {
      await window.cp.app.copy(text);
      U.toast((label || '已复制') + '：' + text, 'ok');
    } catch (e) {
      U.toast('复制失败：' + e.message, 'err');
    }
  };

  U.empty = (msg) => '<div class="empty">' + U.esc(msg) + '</div>';

  U.kv = (k, v) => '<div class="kv"><span class="k">' + U.esc(k) + '</span><span class="v">' + (v == null ? '—' : v) + '</span></div>';

  window.U = U;
})();
