// 上下文窗口（1M）端到端：走 claude-config.js 的真实写入路径，落在一个隔离的 settings.json 上。
// 不碰真实的 ~/.claude/settings.json —— CLAUDE_SETTINGS_PATH 指向临时目录。
//
// 覆盖界面会走的两种操作：切到 1M、再切回 200K（必须真的把键删掉）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'ctx-e2e-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
const FILE = path.join(TMP, 'settings.json');
process.env.CLAUDE_SETTINGS_PATH = FILE;

const { buildPlan, preview, writeSettings, readSettings, CONTEXT_KEY } = await import('../src/main/claude-config.js');

let pass = 0; const fails = [];
const ok = (c, l, d) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fails.push(l); console.log('  ✗ ' + l + (d ? ' → ' + d : '')); } };

// 模拟一份「用户已经在用」的配置：有别的顶层键、有无关 env 键、还开着一个 cc-switch 写的 base url
fs.writeFileSync(FILE, JSON.stringify({
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:3199',
    ANTHROPIC_AUTH_TOKEN: 'PROXY_MA',
    KEEP_ME: 'important',
  },
  skipDangerousModePermissionPrompt: true,
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { PreToolUse: [] },
}, null, 2) + '\n');

// 界面每次改选都会先 preview 再 write —— 两条路径必须给出同一个结论
const payload = (ctx) => ({ baseUrl: 'http://127.0.0.1:3251', token: 'test-key-1m', model: 'cline-pass/glm-5.3-flash', contextTokens: ctx });

console.log('— 切到 1M —');
const p1 = buildPlan(payload(1000000));
const pv1 = preview(p1.env, FILE, p1.remove);
ok(pv1.ok, '预览成功');
ok(pv1.added.includes(CONTEXT_KEY), '预览说这个键是新增', JSON.stringify(pv1.added));
ok((pv1.removed || []).length === 0, '没有要删的键');
ok(pv1.result.env[CONTEXT_KEY] === '1000000', '预览的完整文件内容里带上了 1M');
ok(pv1.result.env.KEEP_ME === 'important', '预览里无关 env 键还在');
ok(pv1.result.skipDangerousModePermissionPrompt === true, '预览里顶层键还在');

const w1 = writeSettings(p1.env, FILE, p1.remove);
ok(w1.ok, '写入成功', w1.error);
const j1 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
ok(j1.env[CONTEXT_KEY] === '1000000', '文件里真的写上了 1M', JSON.stringify(j1.env[CONTEXT_KEY]));
ok(j1.env.KEEP_ME === 'important', '无关 env 键没被动');
ok(j1.skipDangerousModePermissionPrompt === true && j1.permissions && j1.hooks, '顶层键没被动');
ok(j1.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:3251', 'base url 已切到本机代理');

console.log('\n— 切回 200K（关键回归：必须真删，不能留着 1M）—');
const p2 = buildPlan(payload(200000));
const pv2 = preview(p2.env, FILE, p2.remove);
ok(pv2.removed.includes(CONTEXT_KEY), '预览报告会删掉这个键', JSON.stringify(pv2.removed));
ok(!(CONTEXT_KEY in pv2.result.env), '预览的完整文件内容里已经没有这个键');
ok((pv2.removedDiffs || []).some((d) => d.key === CONTEXT_KEY && d.from === '1000000'), '预览给出删除前的原值 1000000');
ok(pv2.result.env.KEEP_ME === 'important', '预览里无关 env 键仍在');

const w2 = writeSettings(p2.env, FILE, p2.remove);
ok(w2.ok && w2.removed.includes(CONTEXT_KEY), '写入返回 removed', JSON.stringify(w2.removed));
const j2 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
ok(!(CONTEXT_KEY in j2.env), '★ 文件里这个键真的没了（不会「选了 200K 实际还是 1M」）', JSON.stringify(j2.env));
ok(j2.env.KEEP_ME === 'important' && j2.permissions && j2.hooks, '删键没有伤到其他内容');
ok(Object.keys(j2.env).length === 13, 'env 里 12 个我们的键 + KEEP_ME，正好 13 个', String(Object.keys(j2.env).length));
ok(Object.keys(j2.env).every((k) => k === 'KEEP_ME' || /^(ANTHROPIC_|CLAUDE_CODE_)/.test(k)), '没有多余/残留的键');

console.log('\n— 还原回到「写入前」—');
// 注意语义：还原的是**最近一次写入之前**的状态，不是「最初的原始状态」。
// 上一次写入是切回 200K，所以写入前那一刻文件里应该是 1M + 本机 base url。
const { restoreLatest, listBackups } = await import('../src/main/claude-config.js');
const r = restoreLatest(FILE);
ok(r.ok, '还原成功', r.error);
const j3 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
ok(j3.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:3251', '还原到最近一次写入前的 base url', String(j3.env.ANTHROPIC_BASE_URL));
ok(j3.env[CONTEXT_KEY] === '1000000', '还原到最近一次写入前的 1M 档', String(j3.env[CONTEXT_KEY]));
ok(j3.env.KEEP_ME === 'important', '还原后无关键仍在');
ok(listBackups(FILE).length > 0, '备份还在');

// 还原的契约是「幂等」，不是「沿历史回退」：永远指向最近那份 .bak-，连点多次停在同一状态。
// 这是刻意设计（见 claude-config.js 的注释）—— 安全备份另存为 .pre-restore- 就是为了不干扰它。
const again = restoreLatest(FILE);
ok(again.ok, '再点一次还原仍然成功（幂等）');
const j4 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
ok(j4.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:3251' && j4.env[CONTEXT_KEY] === '1000000',
  '连点还原停在同一个状态，不会在两种状态之间来回跳',
  JSON.stringify({ base: j4.env.ANTHROPIC_BASE_URL, ctx: j4.env[CONTEXT_KEY] }));

// 但最初那份「用户自己写的」配置必须还躺在某个 .bak- 里，不能被安全备份挤掉
const hasOriginal = listBackups(FILE).some((b) => {
  try {
    const e = JSON.parse(fs.readFileSync(b, 'utf8')).env || {};
    return e.ANTHROPIC_BASE_URL === 'http://127.0.0.1:3199' && e.ANTHROPIC_AUTH_TOKEN === 'PROXY_MA' && e.KEEP_ME === 'important';
  } catch { return false; }
});
ok(hasOriginal, '最初那份原始配置仍在某个备份里（可手工找回）');

console.log('\n— 连续切换 5 轮，状态始终一致 —');
for (let i = 0; i < 5; i++) {
  const on = i % 2 === 0;
  const pl = buildPlan(payload(on ? 1000000 : 200000));
  writeSettings(pl.env, FILE, pl.remove);
  const env = JSON.parse(fs.readFileSync(FILE, 'utf8')).env;
  const has = CONTEXT_KEY in env;
  ok(has === on, '第 ' + (i + 1) + ' 轮：' + (on ? '1M 已写入' : '200K 已删除'), JSON.stringify(env[CONTEXT_KEY]));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过（共 ' + (pass + fails.length) + '）\n' + fails.map((f) => '  - ' + f).join('\n') : '✓ 全部通过（共 ' + pass + ' 项）'));
if (fails.length) process.exit(1);
