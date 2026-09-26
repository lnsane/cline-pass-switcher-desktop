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
const { buildEnv, buildPlan, keysToRemove, mergeSettings, preview, writeSettings, restoreLatest, listBackups,
        readSettings, settingsPath, managedKeys, normalizeContextTokens, CONTEXT_OPTIONS, DEFAULT_CONTEXT_TOKENS,
        CONTEXT_KEY } = mod;

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

// ============ 1b. 上下文窗口（1M）============
console.log('\n— 上下文窗口 —');
const ENV_1M = buildEnv({ baseUrl: 'http://127.0.0.1:3199', token: 't', model: 'cline-pass/glm-5.3-flash', contextTokens: 1000000 });
eq(ENV_1M[CONTEXT_KEY], '1000000', '1M 档写入 CLAUDE_CODE_MAX_CONTEXT_TOKENS');
eq(Object.keys(ENV_1M).length, 13, '1M 档正好 13 个键', String(Object.keys(ENV_1M).length));
ok(!(CONTEXT_KEY in ENV), '默认档**不写**这个键（不给用户配置留无效值）');

// 默认档也要能显式指定，且不落键
ok(!(CONTEXT_KEY in buildEnv({ baseUrl: 'a', token: 't', model: 'm', contextTokens: 200000 })), '显式传 200000 同样不落键');
ok(!(CONTEXT_KEY in buildEnv({ baseUrl: 'a', token: 't', model: 'm', contextTokens: 150000 })), '小于默认值不落键');
ok(!(CONTEXT_KEY in buildEnv({ baseUrl: 'a', token: 't', model: 'm', contextTokens: null })), 'null 不落键');
ok(!(CONTEXT_KEY in buildEnv({ baseUrl: 'a', token: 't', model: 'm' })), '不传参也不落键');

// 想写比 1M 更大的真实窗口也允许（上游有 1,310,720 的渠道）
eq(buildEnv({ baseUrl: 'a', token: 't', model: 'm', contextTokens: 1310720 })[CONTEXT_KEY], '1310720', '任意大于默认的窗口都写');

// 非法输入一律回落默认档，绝不写畸形值进用户配置
for (const bad of ['abc', 0, -1, 999, NaN, Infinity, {}, []]) {
  const v = buildEnv({ baseUrl: 'a', token: 't', model: 'm', contextTokens: bad })[CONTEXT_KEY];
  ok(v === undefined, '非法值 ' + JSON.stringify(bad) + ' 回落默认档（不落键）', String(v));
}
eq(normalizeContextTokens('1000000'), 1000000, 'normalize 接受数字字符串');
eq(normalizeContextTokens(1048576), 1048576, 'normalize 保留非整百万的真实窗口');
eq(normalizeContextTokens(1000000.6), 1000001, 'normalize 取整');
eq(normalizeContextTokens(undefined), DEFAULT_CONTEXT_TOKENS, 'normalize 无参 → 默认');
ok(CONTEXT_OPTIONS.some((o) => Number(o.value) === 1000000), '选项里有 1M');
ok(CONTEXT_OPTIONS.some((o) => Number(o.value) === DEFAULT_CONTEXT_TOKENS), '选项里有默认档');
eq(CONTEXT_OPTIONS.length, 2, '正好两个选项');

eq(managedKeys('m', 1000000)[CONTEXT_KEY], '1000000', 'managedKeys 直接传窗口也生效');
eq(managedKeys('m')[CONTEXT_KEY], undefined, 'managedKeys 不传窗口则不落键');

// keysToRemove：默认档要删，1M 档不删
eq(keysToRemove({ contextTokens: 1000000 }), [], '1M 档没有要删的键');
eq(keysToRemove({ contextTokens: DEFAULT_CONTEXT_TOKENS }), [CONTEXT_KEY], '默认档要删掉这个键');
eq(keysToRemove({}), [CONTEXT_KEY], '不传（=默认档）也要删');
eq(keysToRemove({ contextTokens: 'abc' }), [CONTEXT_KEY], '非法值 = 默认档 = 要删');

// ============ 1c. 换档必须真的把键删掉（不是留在文件里）============
console.log('\n— 换回默认档会删键 —');
const ctxFile = path.join(TMP, 'ctx.json');
fs.writeFileSync(ctxFile, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://x', KEEP_ME: 'y' } }, null, 2) + '\n');
const plan1 = buildPlan({ baseUrl: 'http://127.0.0.1:3199', token: 't', model: 'm', contextTokens: 1000000 });
writeSettings(plan1.env, ctxFile, plan1.remove);
eq(JSON.parse(fs.readFileSync(ctxFile, 'utf8')).env[CONTEXT_KEY], '1000000', '切到 1M 后文件里有这个键');

const pv = preview(plan1.env, ctxFile, plan1.remove);
ok(pv.removed.length === 0, '1M 档预览不报告删除');

// 关键回归：再切回默认档，键必须**消失**
const plan2 = buildPlan({ baseUrl: 'http://127.0.0.1:3199', token: 't', model: 'm', contextTokens: DEFAULT_CONTEXT_TOKENS });
const pv2 = preview(plan2.env, ctxFile, plan2.remove);
ok(pv2.removed.includes(CONTEXT_KEY), '默认档预览报告会删掉这个键', JSON.stringify(pv2.removed));
ok((pv2.removedDiffs || []).some((d) => d.key === CONTEXT_KEY && d.from === '1000000'), '预览给出删除前的原值');
const w2 = writeSettings(plan2.env, ctxFile, plan2.remove);
ok(w2.ok && w2.removed.includes(CONTEXT_KEY), '写入返回 removed 列表', JSON.stringify(w2.removed));
const back = JSON.parse(fs.readFileSync(ctxFile, 'utf8')).env;
ok(!(CONTEXT_KEY in back), '切回默认档后键真的没了（不会「选了 200K 实际还是 1M」）', JSON.stringify(back));
eq(back.KEEP_ME, 'y', '删键不影响其他无关的 env 键');
eq(back.ANTHROPIC_BASE_URL, 'http://127.0.0.1:3199', '我们的其他键照常写入');

// 再来回切一轮，确认可逆
writeSettings(buildPlan({ baseUrl: 'a', token: 't', model: 'm', contextTokens: 1000000 }).env, ctxFile, []);
eq(JSON.parse(fs.readFileSync(ctxFile, 'utf8')).env[CONTEXT_KEY], '1000000', '再切回 1M 又能写入');
writeSettings(plan2.env, ctxFile, plan2.remove);
ok(!(CONTEXT_KEY in JSON.parse(fs.readFileSync(ctxFile, 'utf8')).env), '再切回默认档又删掉（反复切换稳定）');

// 删除权限边界：只允许删我们自己的键，别的键一概拒绝
console.log('\n— 删键的权限边界 —');
const guard = mergeSettings({ env: { KEEP_ME: 'y', ANTHROPIC_MODEL: 'old' } },
  { ANTHROPIC_MODEL: 'new' }, [CONTEXT_KEY, 'KEEP_ME', 'PATH', 'ANTHROPIC_AUTH_TOKEN']);
eq(guard.settings.env.KEEP_ME, 'y', 'env 里与工具无关的键**不能**被删（KEEP_ME 还在）');
ok(!guard.removed.includes('KEEP_ME'), 'removed 不含越权的键', JSON.stringify(guard.removed));
ok(!guard.removed.includes('PATH'), 'removed 不含 PATH');
ok(guard.removed.includes('ANTHROPIC_AUTH_TOKEN') === false, '原本不存在的键不报 removed');
eq(guard.settings.env.ANTHROPIC_MODEL, 'new', '正常的合并照常发生');
const guard2 = mergeSettings({ env: { ANTHROPIC_BASE_URL: 'x' } }, {}, ['ANTHROPIC_BASE_URL']);
eq(guard2.settings.env.ANTHROPIC_BASE_URL, undefined, '我们自己的键可以被删');
ok(guard2.removed.includes('ANTHROPIC_BASE_URL'), '自己的键删除会被记录');

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
