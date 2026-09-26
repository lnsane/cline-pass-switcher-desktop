// claude-config.js 的离线测试：合并、备份、还原、拒绝写入非法 JSON
// 全程在一个临时目录里操作，不碰真实的 ~/.claude/settings.json
// 用法: node scripts/test-claude-config.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = path.join(os.tmpdir(), 'ccfg-test-' + Date.now());
fs.mkdirSync(TMP, { recursive: true });
process.env.CLAUDE_SETTINGS_PATH = path.join(TMP, 'settings.json');

const mod = await import('../src/main/claude-config.js');
const { buildEnv, mergeSettings, preview, writeSettings, restoreLatest, listBackups, readSettings, settingsPath } = mod;

let pass = 0;
const fails = [];
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  ✓ ' + label); }
  else { fails.push(label + (detail ? ' → ' + detail : '')); console.log('  ✗ ' + label + (detail ? ' → ' + detail : '')); }
}
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, 'got ' + JSON.stringify(a) + ' want ' + JSON.stringify(b));

const FILE = settingsPath();
const ENV = buildEnv({ baseUrl: 'http://127.0.0.1:3199', token: 'local-proxy-no-key', model: 'cline-pass/deepseek-v4.1-flash' });

// ============ 1. buildEnv ============
console.log('\n— buildEnv —');
eq(ENV.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', 'BASE_URL 用根地址（客户端自己拼 /v1/messages）');
eq(ENV.ANTHROPIC_AUTH_TOKEN, 'local-proxy-no-key', 'AUTH_TOKEN');
eq(ENV.ANTHROPIC_MODEL, 'cline-pass/deepseek-v4.1-flash', 'MODEL');
eq(ENV.ANTHROPIC_DEFAULT_OPUS_MODEL_NAME, ENV.ANTHROPIC_DEFAULT_OPUS_MODEL, 'MODEL 与 MODEL_NAME 写同一个值（不留旧值造成不一致）');
ok(ENV.CLAUDE_CODE_SUBAGENT_MODEL === ENV.ANTHROPIC_MODEL, '子代理模型也指向同一个');
eq(Object.keys(ENV).length, 12, '正好 12 个键', String(Object.keys(ENV).length));

// ============ 2. mergeSettings 是纯函数，保护既有配置 ============
console.log('\n— mergeSettings（纯函数）—');
const existing = {
  env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15722', ANTHROPIC_AUTH_TOKEN: 'PROXY_MA', KEEP_ME: 'x' },
  skipDangerousModePermissionPrompt: true,
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: { PreToolUse: [] },
};
const m = mergeSettings(existing, ENV);
eq(m.settings.skipDangerousModePermissionPrompt, true, '顶层非 env 键原样保留');
eq(m.settings.permissions, existing.permissions, 'permissions 原样保留');
eq(m.settings.hooks, existing.hooks, 'hooks 原样保留');
eq(m.settings.env.KEEP_ME, 'x', 'env 里与我们无关的键原样保留');
eq(m.settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', '我们的键被覆盖成新值');
ok(existing.env.ANTHROPIC_BASE_URL === 'http://127.0.0.1:15722', '不修改传入的原对象（纯函数）');
ok(m.changed.includes('ANTHROPIC_BASE_URL') && m.changed.includes('ANTHROPIC_AUTH_TOKEN'), 'changed 正确列出被改的键', JSON.stringify(m.changed));
ok(m.added.includes('ANTHROPIC_MODEL'), 'added 正确列出新增的键', JSON.stringify(m.added));
eq(m.same, [], '没有本来就相同的键');

// 已有部分键相同的情况
const m2 = mergeSettings({ env: { ANTHROPIC_MODEL: ENV.ANTHROPIC_MODEL } }, ENV);
ok(m2.same.includes('ANTHROPIC_MODEL') && !m2.changed.includes('ANTHROPIC_MODEL'), '值相同时归入 same 而不是 changed');
ok(m2.added.includes('ANTHROPIC_BASE_URL'), '缺的键归入 added');

// 空 / 脏输入
eq(mergeSettings(null, ENV).settings.env.ANTHROPIC_MODEL, ENV.ANTHROPIC_MODEL, 'null 配置也能合并');
eq(mergeSettings({ env: 'not-an-object' }, ENV).settings.env.ANTHROPIC_MODEL, ENV.ANTHROPIC_MODEL, 'env 不是对象时也能合并');
eq(mergeSettings({ env: null }, ENV).settings.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', 'env 为 null 时也能合并');

// ============ 3. 首次写入（文件不存在）============
console.log('\n— 首次写入 —');
ok(!fs.existsSync(FILE), '测试起点：文件不存在');
const p0 = preview(ENV, FILE);
ok(p0.ok && p0.exists === false, 'preview 报告文件不存在');
const w0 = writeSettings(ENV, FILE);
ok(w0.ok, '写入成功', w0.error);
ok(w0.backupPath === null, '文件不存在时不产生备份（没什么可备）');
ok(fs.existsSync(FILE), '文件已创建');
const j0 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
eq(j0.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', '内容正确');
eq(Object.keys(j0).length, 1, '只写了 env 一个顶层键', JSON.stringify(Object.keys(j0)));
ok(fs.readFileSync(FILE, 'utf8').endsWith('\n'), '以换行结尾（编辑器友好）');

// ============ 4. 已有配置时：备份 + 合并写 ============
console.log('\n— 合并写入（含备份）—');
const ORIGINAL = JSON.stringify(existing, null, 2) + '\n';
fs.writeFileSync(FILE, ORIGINAL);
// preview 要在写入之前看（写完之后就没有 before → after 了）
const p1 = preview(ENV, FILE);
ok(p1.ok && p1.diffs.some((d) => d.key === 'ANTHROPIC_BASE_URL' && d.from === 'http://127.0.0.1:15722' && d.to === 'http://127.0.0.1:3199'), 'preview 给出 before → after');
ok(p1.keptTopLevel.includes('skipDangerousModePermissionPrompt'), 'preview 报告会保留的顶层键', JSON.stringify(p1.keptTopLevel));
const w1 = writeSettings(ENV, FILE);
ok(w1.ok, '写入成功', w1.error);
ok(!!w1.backupPath && fs.existsSync(w1.backupPath), '产生了备份文件', String(w1.backupPath));
eq(fs.readFileSync(w1.backupPath, 'utf8'), ORIGINAL, '备份内容是写入前的原文（可完整还原）');
const j1 = JSON.parse(fs.readFileSync(FILE, 'utf8'));
eq(j1.skipDangerousModePermissionPrompt, true, '写入后顶层键仍在');
eq(j1.permissions, existing.permissions, '写入后 permissions 仍在');
eq(j1.env.KEEP_ME, 'x', '写入后无关 env 键仍在');
eq(j1.env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', '我们的键已更新');
ok(w1.changed.includes('ANTHROPIC_BASE_URL'), '返回了 changed 列表', JSON.stringify(w1.changed));
ok(!fs.readdirSync(TMP).some((n) => n.includes('.tmp-')), '没有残留的临时文件');

// ============ 4b. 写入后「立刻」还原（回归：秒级时间戳会让安全备份覆盖源备份）============
console.log('\n— 写入后立刻还原（连做 3 次）—');
for (let i = 0; i < 3; i++) {
  fs.writeFileSync(FILE, ORIGINAL);
  const w = writeSettings(ENV, FILE);
  const rr = restoreLatest(FILE);
  ok(w.ok && rr.ok, '第 ' + (i + 1) + ' 轮写入与还原都成功', (w.error || rr.error || ''));
  eq(fs.readFileSync(FILE, 'utf8'), ORIGINAL, '第 ' + (i + 1) + ' 轮：还原后与原始字节一致');
}
// 备份文件里必须至少有一份是与原始内容一致的（源备份没被安全备份毁掉）
const anyGood = listBackups(FILE).some((b) => { try { return fs.readFileSync(b, 'utf8') === ORIGINAL; } catch { return false; } });
ok(anyGood, '备份里仍留有一份与原始内容一致的副本');

// ============ 5. 还原（幂等：连点多次都应停在写入前的状态）============
console.log('\n— 还原 —');
fs.writeFileSync(FILE, ORIGINAL);
const w5 = writeSettings(ENV, FILE);
const r = restoreLatest(FILE);
ok(w5.ok && r.ok, '写入后还原成功', r.error);
eq(fs.readFileSync(FILE, 'utf8'), ORIGINAL, '还原后与原始字节一致');
ok(!!r.safetyBackup && fs.existsSync(r.safetyBackup), '还原前对被覆盖的内容做了安全备份');
ok(r.restoredFrom.includes('.bak-'), '还原目标取自「写入前备份」而不是安全备份', r.restoredFrom);
// 关键：安全备份不能成为下一次还原的目标，否则连点两次会跳回被写入的状态
const r2 = restoreLatest(FILE);
ok(r2.ok, '第二次还原也成功');
eq(fs.readFileSync(FILE, 'utf8'), ORIGINAL, '第二次还原后仍是原始内容（还原是幂等的）');
const r3 = restoreLatest(FILE);
eq(fs.readFileSync(FILE, 'utf8'), ORIGINAL, '第三次还原后仍是原始内容');
// 必须始终留着一份与原始内容一致的备份，不能被安全备份挤掉
const stillHasOriginal = listBackups(FILE).some((b) => { try { return fs.readFileSync(b, 'utf8') === ORIGINAL; } catch { return false; } });
ok(stillHasOriginal, '写入前的那份备份始终还在');

// ============ 6. 非法 JSON：必须拒绝写入，且不动原文件 ============
console.log('\n— 非法 JSON 拒绝写入 —');
const BROKEN = '{ this is not json';
fs.writeFileSync(FILE, BROKEN);
const pb = preview(ENV, FILE);
ok(!pb.ok && /JSON/.test(pb.error || ''), 'preview 报错而不是猜', pb.error);
const wb = writeSettings(ENV, FILE);
ok(!wb.ok, '拒绝写入', wb.error);
eq(fs.readFileSync(FILE, 'utf8'), BROKEN, '原文件一个字节都没动');

// 空文件同样拒绝
fs.writeFileSync(FILE, '   \n');
ok(!writeSettings(ENV, FILE).ok, '空文件也拒绝写入');
eq(fs.readFileSync(FILE, 'utf8'), '   \n', '空文件未被改动');

// ============ 7. 顶层是数组 / 标量：拒绝（不能把配置写成数组）============
console.log('\n— 顶层类型异常 —');
fs.writeFileSync(FILE, '[1,2,3]');
const wa = writeSettings(ENV, FILE);
ok(wa.ok, '顶层是数组时按空配置处理并写入（mergeSettings 有兜底）', wa.error);
ok(JSON.parse(fs.readFileSync(FILE, 'utf8')).env, '写入结果是带 env 的对象');

// ============ 8. 备份轮转 ============
console.log('\n— 备份轮转 —');
const fresh = path.join(TMP, 'rotate.json');
fs.writeFileSync(fresh, '{}\n');
for (let i = 0; i < 14; i++) writeSettings(ENV, fresh);
const backups = listBackups(fresh);
ok(backups.length <= 10, '备份最多保留 10 份', String(backups.length));
ok(listBackups(fresh).length > 0, '仍然留有备份');

// ============ 9. 没有备份时还原应报错而不是乱来 ============
console.log('\n— 边界 —');
const none = path.join(TMP, 'nobak.json');
fs.writeFileSync(none, '{}\n');
const rn = restoreLatest(none);
ok(!rn.ok && /没有可用/.test(rn.error || ''), '无备份时还原明确报错', rn.error);
eq(fs.readFileSync(none, 'utf8'), '{}\n', '无备份时文件不变');

// 读取不存在的文件
const missing = readSettings(path.join(TMP, 'never.json'));
ok(missing.exists === false && missing.error === null, '读不存在的文件不报错，只报告不存在');

fs.rmSync(TMP, { recursive: true, force: true });

console.log('\n' + (fails.length ? '✗ ' + fails.length + ' 项未通过（共 ' + (pass + fails.length) + '）' : '✓ 全部通过（共 ' + pass + ' 项）'));
if (fails.length) {
  console.log(fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
