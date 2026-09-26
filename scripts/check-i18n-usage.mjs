// 检查 locale-en.js 里的重复键 —— 重复的后者会静默覆盖前者，是很容易漏的错。
// 同时用语料库里的真实中文串反查：哪些串还没翻译。
import fs from 'node:fs';

const src = fs.readFileSync('src/renderer/js/locale-en.js', 'utf8');
const keys = [...src.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)].map((m) => m[1]);
const seen = new Map();
let dup = 0;
keys.forEach((k, i) => {
  if (seen.has(k)) { console.log('重复键:', JSON.stringify(k)); dup++; }
  seen.set(k, i);
});
console.log(`键总数: ${keys.length}，重复: ${dup}`);

// 从界面源码里抽出所有 T('...') / U.esc(T('...')) 的字面串，反查缺失
const files = [
  'src/renderer/js/views/usage.js',
  'src/renderer/js/app.js',
];
const missing = new Set();
for (const f of files) {
  const s = fs.readFileSync(f, 'utf8');
  for (const m of s.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'/g)) {
    const k = m[1];
    if (/[一-鿿]/.test(k) && !seen.has(k)) missing.add(k);
  }
}
console.log(`\n未翻译的 T() 串: ${missing.size}`);
for (const m of missing) console.log('  ' + m);

// 缺翻译要**失败**：界面上会直接漏出中文，是真实的回归信号。
// 重复键只报告不失败 —— 文件里历史遗留的重复有几十处（后者覆盖前者，行为确定），
// 全部清掉不在本次范围内，但不该让它挡住 CI。
if (missing.size) {
  console.error('\n✗ 有中文串没有英文译文（英文界面会漏中文）');
  process.exit(1);
}
console.log('\n✓ 用量页与外壳的中文串都有英文译文');
