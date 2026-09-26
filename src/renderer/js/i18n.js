// 国际化：语言检测 + 翻译表 + DOM 翻译
//
// 设计取舍（这套方案是权衡后的结果，不是随手选的）：
//
// 1. **翻译键用中文原文**，而不是 `nav.overview` 这类符号键。
//    理由：界面文字本来就是中文写死的，用中文当键意味着「没翻译的地方自动回落成中文」，
//    不会出现 key 拼错导致界面空白。对几百条字符串的一次性国际化，
//    这比引入符号键体系 + 大改 20 个文件稳妥得多。
//
// 2. **DOM 层翻译，而不是在每处字符串套 T()。**
//    渲染层每个视图都是 `root.innerHTML = ...`，统一在渲染后走一遍 DOM 替换，
//    就不必改业务代码。附带好处：用户数据（账号名、模型 ID、URL）不在翻译表里，
//    自然原样保留 —— 不会把「账号1」这种数据误译。
//
// 3. **支持带数字的模式匹配。** 界面上有很多「渠道 (4)」「还有 338 个未显示」
//    「3 天 11 小时后重置」，它们是运行时拼出来的，精确匹配表里不会有。
//    所以翻译表里的键可以写成带 {n} 占位符的模式，翻译时按正则匹配。
//
// 4. **MutationObserver 覆盖动态内容**：表格筛选、toast、模态都是渲染后插入的，
//    光在导航时翻译一次不够。
(function () {
  'use strict';

  const SUPPORTED = ['zh', 'en'];
  const FALLBACK = 'zh';

  let mode = 'auto';       // 'auto' | 'zh' | 'en'
  let current = FALLBACK;
  let observer = null;
  let translating = false; // 防止 observer 自己触发自己

  // ---------- 语言检测 ----------
  function detectSystem() {
    const langs = [];
    if (window.APP && window.APP.boot && window.APP.boot.systemLocale) langs.push(window.APP.boot.systemLocale);
    if (navigator.languages && navigator.languages.length) langs.push(...navigator.languages);
    if (navigator.language) langs.push(navigator.language);
    for (const l of langs) {
      const low = String(l || '').toLowerCase();
      if (low.startsWith('zh')) return 'zh';
      if (low.startsWith('en')) return 'en';
    }
    return FALLBACK;
  }

  function resolve() {
    current = mode === 'auto' ? detectSystem() : (SUPPORTED.includes(mode) ? mode : FALLBACK);
    return current;
  }

  // ---------- 翻译 ----------
  // 精确表：中文原文 → 译文
  function dict() {
    return (window.LOCALES && window.LOCALES[current]) || {};
  }

  // 模式表：[{ re, to }] —— 用于「渠道 ({n})」这类运行时拼接的文本
  function patterns() {
    return (window.LOCALE_PATTERNS && window.LOCALE_PATTERNS[current]) || [];
  }

  // 翻译一段文本。中文界面（current==='zh'）直接返回原文，不做任何查找 ——
  // 省掉无谓开销，也避免中文到中文的意外替换。
  function T(text, vars) {
    if (text == null) return '';
    let s = String(text);
    if (current === 'zh') return vars ? subst(s, vars) : s;

    const d = dict();
    // 1) 精确命中
    if (d[s] != null) s = d[s];
    else {
      // 2) 模式命中（带数字的运行时文本）
      for (const p of patterns()) {
        if (p.re.test(s)) { s = s.replace(p.re, p.to); break; }
      }
      // 3) 整体没命中，试试按行/按句拆分（有些文本节点是多行拼的）
      if (s === text && /[一-鿿]/.test(s)) {
        s = s.split('\n').map((line) => {
          const t = line.trim();
          if (!t || !/[一-鿿]/.test(t)) return line;
          if (d[t] != null) return line.replace(t, d[t]);
          for (const p of patterns()) {
            if (p.re.test(t)) return line.replace(t, t.replace(p.re, p.to));
          }
          return line;
        }).join('\n');
      }
    }
    return vars ? subst(s, vars) : s;
  }

  const subst = (s, vars) => s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));

  // 哪些节点不该翻译：脚本、样式、输入框里的值、代码块、用户数据区
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'CODE', 'PRE', 'NOSCRIPT', 'TEXTAREA']);
  // 标了 data-i18n-skip 的子树整体跳过（放用户数据，比如原始错误信息）
  function shouldSkip(node) {
    let el = node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (SKIP_TAGS.has(el.tagName)) return true;
      if (el.hasAttribute && el.hasAttribute('data-i18n-skip')) return true;
      el = el.parentElement;
    }
    return false;
  }

  // 走一遍 DOM，把文本节点与常见属性翻掉
  function applyToDom(root) {
    if (current === 'zh') return;
    const scope = root || document.body;
    if (!scope) return;

    // 文本节点
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    const jobs = [];
    let n;
    while ((n = walker.nextNode())) {
      const raw = n.nodeValue;
      if (!raw || !/[一-鿿]/.test(raw)) continue;
      if (shouldSkip(n)) continue;
      const lead = raw.match(/^\s*/)[0];
      const trail = raw.match(/\s*$/)[0];
      const core = raw.slice(lead.length, raw.length - trail.length);
      if (!core) continue;
      const out = T(core);
      if (out !== core) jobs.push([n, lead + out + trail]);
    }
    // 属性
    for (const el of scope.querySelectorAll('[placeholder],[title],[aria-label],[alt]')) {
      if (shouldSkip(el)) continue;
      for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
        const v = el.getAttribute(attr);
        if (!v || !/[一-鿿]/.test(v)) continue;
        const out = T(v);
        if (out !== v) jobs.push([el, attr, out]);
      }
    }
    // 统一写入（避免在遍历中改 DOM）
    for (const j of jobs) {
      if (j.length === 2) j[0].nodeValue = j[1];
      else j[0].setAttribute(j[1], j[2]);
    }
    document.documentElement.setAttribute('lang', current === 'zh' ? 'zh-CN' : 'en');
  }

  // 动态内容：表格筛选、toast、模态都是渲染后插入的，导航时翻一次不够
  function startObserver() {
    if (observer || current === 'zh') return;
    observer = new MutationObserver((records) => {
      if (translating) return;
      translating = true;
      try {
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (node.nodeType === 1) applyToDom(node);
            else if (node.nodeType === 3 && node.parentElement) applyToDom(node.parentElement);
          }
        }
      } finally {
        translating = false;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // 只设置语言、不重载。给启动路径用 —— 启动时若调用 setMode 会触发
  // location.reload()，变成无限重载循环。
  function configure(nextMode) {
    mode = SUPPORTED.includes(nextMode) ? nextMode : 'auto';
    resolve();
    document.documentElement.setAttribute('lang', current === 'zh' ? 'zh-CN' : 'en');
    return current;
  }

  // 用户在设置里切换语言：整页重载。
  //
  // 为什么不「就地翻译」：翻译是把 DOM 里的中文文本节点改写成英文，原文就没了，
  // 切回中文时无从还原（侧边栏、标题栏这些静态 HTML 也在内）。
  // 重载最省事，也绝不会出现中英混排的中间态 —— 渲染层没有需要保留的
  // 未保存状态（设置项都是改完即存），重载没有副作用。
  function setMode(next) {
    configure(next);
    location.reload();
    return { lang: current };
  }

  // 启动时调用：定好语言，英文界面还要翻译一遍并开始观察动态内容
  function boot() {
    if (current !== 'zh') { applyToDom(); startObserver(); }
    return current;
  }

  window.I18N = {
    get mode() { return mode; },
    get lang() { return current; },
    get supported() { return SUPPORTED.slice(); },
    detectSystem, resolve, configure, setMode, applyToDom, boot, T,
    /** 当前语言的显示名（给设置页的下拉用） */
    label: (code) => ({ auto: '跟随系统 / System', zh: '中文', en: 'English' }[code] || code),
  };
  window.T = T;
})();
