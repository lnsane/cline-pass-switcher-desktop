// 静态自查：未使用的 import、英文译文里混入中文（后者会让 i18n 观察者反复重译）
import fs from 'node:fs';
import path from 'node:path';

const FILES = [
  'src/main/engine/engine.js',
  'src/main/engine/usage.js',
  'src/main/engine/pricing-cny.js',
  'src/main/engine/anthropic.js',
  'src/main/main.js',
];

console.log('=== 1. 未使用的 import ===');
for (const f of FILES) {
  const s = fs.readFileSync(f, 'utf8');
  // 收集 import 的具名
  const names = [];
  for (const m of s.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"][^'"]+['"]/g)) {
    if (m[1]) names.push(m[1]);
    if (m[2]) for (const part of m[2].split(',')) {
      const n = part.trim().split(/\s+as\s+/).pop().trim();
      if (n) names.push(n);
    }
  }
  // 去掉 import 行之后再看有没有出现
  const body = s.split('\n').filter((l) => !/^\s*import\s/.test(l) && !/^\s*\}\s*from\s/.test(l)).join('\n');
  const unused = names.filter((n) => !new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`).test(body));
  console.log(`  ${f}: ${unused.length ? '未使用 -> ' + unused.join(', ') : 'ok'}`);
}

console.log('\n=== 2. 英文译文里混入中文 ===');
{
  const s = fs.readFileSync('src/renderer/js/locale-en.js', 'utf8');
  const bad = [];
  const re = /^\s*'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  let m;
  while ((m = re.exec(s))) {
    if (/[一-鿿]/.test(m[2])) bad.push([m[1], m[2]]);
  }
  if (!bad.length) console.log('  无（安全）');
  else {
    console.log(`  发现 ${bad.length} 处（英文界面会漏中文，且可能让观察者反复重译）:`);
    for (const [k, v] of bad) console.log(`    ${k.slice(0, 28)}  ->  ${v.slice(0, 46)}`);
  }
}

console.log('\n=== 3. 译文值里是否含有译文键本身（自映射会触发无限重译）===');
{
  const s = fs.readFileSync('src/renderer/js/locale-en.js', 'utf8');
  const re = /^\s*'((?:[^'\\]|\\.)*)':\s*'((?:[^'\\]|\\.)*)',?\s*$/gm;
  const selfMap = [];
  let m;
  while ((m = re.exec(s))) if (m[1] === m[2] && /[一-鿿]/.test(m[1])) selfMap.push(m[1]);
  console.log(selfMap.length ? `  自映射 ${selfMap.length} 处: ` + selfMap.join(', ') : '  无');
}

console.log('\n=== 4. 重复键（后者覆盖前者）===');
{
  const s = fs.readFileSync('src/renderer/js/locale-en.js', 'utf8');
  const re = /^\s*'((?:[^'\\]|\\.)*)':/gm;
  const seen = new Map();
  let m;
  let dup = 0;
  while ((m = re.exec(s))) {
    if (seen.has(m[1])) dup++;
    seen.set(m[1], 1);
  }
  console.log(`  键 ${seen.size} 个，重复 ${dup} 处`);
}

console.log('\n=== 5. views 里是否还有 T() 用得到但词典没有的串 ===');
{
  const dict = fs.readFileSync('src/renderer/js/locale-en.js', 'utf8');
  const keys = new Set();
  for (const m of dict.matchAll(/^\s*'((?:[^'\\]|\\.)*)':/gm)) keys.add(m[1]);
  const dir = 'src/renderer/js';
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js') && !e.name.startsWith('locale-')) files.push(p);
    }
  };
  walk(dir);
  const missing = new Set();
  for (const f of files) {
    const s = fs.readFileSync(f, 'utf8');
    for (const m of s.matchAll(/\bT\(\s*'((?:[^'\\]|\\.)*)'/g)) {
      if (/[一-鿿]/.test(m[1]) && !keys.has(m[1])) missing.add(m[1]);
    }
  }
  console.log(missing.size ? `  缺译文 ${missing.size} 个:` : '  无缺失');
  for (const m of missing) console.log('    ' + m);
}
