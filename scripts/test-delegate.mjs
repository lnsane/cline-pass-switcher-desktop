// 事件委托 U.delegate 的绑定语义回归测试
//
// 为什么必须单独测：这个缺陷是**静默**的 —— 页面照样渲染，按钮却点不动，
// 没有任何报错、没有 console 输出，`node --check` 和静态自查也看不出来
// （check-static 只查未使用 import / 译文 / 重复键）。
// 实测过的事故：`U.delegate` 只在**首个**事件类型到达时为容器挂监听，
// 于是先注册 `change` 的视图里，之后注册的 `input` / `click` 全部永远绑不上 ——
// 账号池的「删除」「测试」「新增」「保存」因此全都没反应。
//
// 这里用一个最小 DOM（真实冒泡 + closest + contains）在 node 里跑，
// 不引入 jsdom：仓库是零依赖的。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) { pass++; return; }
  fail++; failures.push(label);
}
function eq(a, b, label) {
  if (a === b) { pass++; return; }
  fail++; failures.push(`${label}\n     期望: ${JSON.stringify(b)}\n     实得: ${JSON.stringify(a)}`);
}

// ---------- 最小 DOM ----------
// 只实现 U.delegate 真正用到的那几个能力，但**事件冒泡是真的**：
// 目标元素派发事件后逐级冒泡到父节点，父节点上的监听器才会被触发。
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.parentNode = null;
    this.childNodes = [];
    this.attrs = {};
    this._listeners = new Map();
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  setAttribute(name, value) { this.attrs[name] = String(value); return this; }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null; }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  listenerTypes() { return Array.from(this._listeners.keys()); }
  contains(other) {
    for (let n = other; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  // 支持以空格分隔的组合选择器里最简单的一类："tag.cls" / ".cls" / "[attr]"
  matches(sel) {
    return String(sel).split(/\s+/).every((part) => {
      if (part.startsWith('[')) {
        const name = part.slice(1, -1).replace(/[=~|^$*].*$/, '').replace(/"/g, '');
        return name in this.attrs;
      }
      const cls = (part.match(/\.[\w-]+/g) || []).map((s) => s.slice(1));
      const tag = part.replace(/\..*$/, '').replace(/\[.*$/, '');
      if (tag && tag !== '*' && this.tagName !== tag.toUpperCase()) return false;
      const own = String(this.className || '').split(/\s+/);
      return cls.every((c) => own.includes(c));
    });
  }
  closest(sel) {
    for (let n = this; n; n = n.parentNode) if (n.matches && n.matches(sel)) return n;
    return null;
  }
  dispatchEvent(ev) {
    ev.target = this;
    const chain = [];
    for (let n = this; n; n = n.parentNode) chain.push(n);
    // 冒泡：目标 → 各级祖先
    for (const node of chain) {
      const list = node._listeners.get(ev.type);
      if (list) for (const fn of list.slice()) fn.call(node, ev);
    }
    return true;
  }
}
const div = (cls) => { const e = new El('div'); if (cls) e.className = cls; return e; };
const btn = (cls) => { const e = new El('button'); if (cls) e.className = cls; return e; };
const fire = (el, type, opts = {}) => el.dispatchEvent({ type, bubbles: true, ...opts });

// ---------- 载入被测模块 ----------
// util.js 是 IIFE，挂 window.U；用 vm 在一个带 window 的上下文里跑，避免污染全局。
const utilSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'js', 'util.js'), 'utf8');
const sandbox = { window: {}, document: { addEventListener() {}, querySelector: () => null } };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(utilSrc, sandbox, { filename: 'util.js' });
const U = sandbox.window.U;
ok(!!U && typeof U.delegate === 'function', '1. util.js 载入后暴露 U.delegate');

// ---------- 1. 核心缺陷：不同事件类型必须各自绑上 ----------
{
  const root = div('view');
  const a = div('c');
  const b = btn('k');
  root.appendChild(a); root.appendChild(b);

  let changeHits = 0, clickHits = 0, inputHits = 0;
  // 完全照抄 accounts.js wire() 的顺序：change → input → click
  U.delegate(root, 'change', '.c', () => changeHits++);
  U.delegate(root, 'input', '.c', () => inputHits++);
  U.delegate(root, 'click', '.k', () => clickHits++);

  eq(root.listenerTypes().sort().join(','), 'change,click,input',
    '2. 三种事件类型在容器上各挂了一个监听（事故：只挂了 change）');

  fire(a, 'change');
  fire(a, 'input');
  fire(b, 'click');
  eq(changeHits, 1, '3. change 处理器被触发');
  eq(inputHits, 1, '4. input 处理器被触发（事故：永远触发不到）');
  eq(clickHits, 1, '5. click 处理器被触发（事故：永远触发不到）');
}

// ---------- 2. 顺序无关：click 先注册也必须能让 change 生效 ----------
{
  const root = div('view');
  const a = btn('k');
  const b = div('c');
  root.appendChild(a); root.appendChild(b);
  let clickHits = 0, changeHits = 0;
  U.delegate(root, 'click', '.k', () => clickHits++);
  U.delegate(root, 'change', '.c', () => changeHits++);
  fire(a, 'click'); fire(b, 'change');
  eq(clickHits, 1, '6. click 先注册时仍然生效');
  eq(changeHits, 1, '7. click 先注册时 change 也生效（顺序无关）');
}

// ---------- 3. 重绘不累积：同一 (事件, 选择器) 反复绑定只有最后一次算数 ----------
{
  const root = div('view');
  const k = btn('k');
  root.appendChild(k);
  let hits = 0;
  for (let i = 0; i < 5; i++) U.delegate(root, 'click', '.k', () => hits++);
  fire(k, 'click');
  eq(hits, 1, '8. 同一 (事件, 选择器) 绑 5 次，一次点击只触发一次（不重复叠加）');
  eq(root.listenerTypes().length, 1, '9. 反复绑定不会累积出多个监听');
}

// ---------- 4. 同事件多选择器：各自匹配各自的 ----------
{
  const root = div('view');
  const k = btn('k');
  const other = btn('other');
  root.appendChild(k); root.appendChild(other);
  let kHits = 0, oHits = 0;
  U.delegate(root, 'click', '.k', () => kHits++);
  U.delegate(root, 'click', '.other', () => oHits++);
  fire(other, 'click');
  eq(kHits, 0, '10. 点 .other 不会触发 .k 的处理器');
  eq(oHits, 1, '11. 点 .other 只触发 .other 的处理器');
}

// ---------- 5. 冒泡到容器才响应：容器外的元素不该被劫持 ----------
{
  const root = div('view');
  const inside = btn('k');
  const outside = btn('k');
  root.appendChild(inside);
  let hits = 0;
  U.delegate(root, 'click', '.k', () => hits++);
  fire(inside, 'click');
  eq(hits, 1, '12. 容器内的目标触发处理器');
  fire(outside, 'click');   // 不在 root 子树里，冒泡不会经过 root
  eq(hits, 1, '13. 容器外的同名元素不会触发（root.contains 与冒泡共同保证）');
}

// ---------- 6. 注册之后再重绘（innerHTML 清空重建）依然有效 ----------
{
  const root = div('view');
  const first = btn('k');
  root.appendChild(first);
  let hits = 0;
  U.delegate(root, 'click', '.k', () => hits++);
  fire(first, 'click');
  eq(hits, 1, '14. 首次绑定的元素可点击');

  // 模拟视图重绘：清空子节点、放回一个新按钮，再走一遍 wire()。
  // 重绘会重新绑定同一个 (事件, 选择器)，新处理器覆盖旧的 —— 于是累计仍是「一点一次」。
  root.childNodes.slice().forEach((c) => root.removeChild(c));
  const rebuilt = btn('k');
  root.appendChild(rebuilt);
  let staleHits = 0;
  U.delegate(root, 'click', '.k', () => hits++);
  fire(rebuilt, 'click');
  eq(hits, 2, '15. 重绘后新元素可点击，且旧处理器已被覆盖（两次点击累计 2 次）');

  // 重绑之后必须**只**跑新处理器：旧闭包不得再被调用
  U.delegate(root, 'click', '.k', () => staleHits++);
  fire(rebuilt, 'click');
  eq(staleHits, 1, '15b. 重绑后只跑最新处理器');
  eq(hits, 2, '15c. 被覆盖的旧处理器不再被调用');
}

// ---------- 7. 空容器 / null 根：不抛异常 ----------
{
  const root = div('view');
  U.delegate(root, 'click', '.nothing', () => { throw new Error('不该被调用'); });
  fire(root, 'click');
  pass++; // 走到这里说明没有抛异常
  eq(U.delegate(null, 'click', '.x', () => {}), null, '16. root 为 null 时安全返回 null');
}

console.log(`\n事件委托绑定：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
