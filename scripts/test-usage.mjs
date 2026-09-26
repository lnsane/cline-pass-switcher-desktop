// 用量统计核心模块的离线单元测试
// 覆盖：token 口径换算、定价查找与估算、按天汇总、去重、明细裁剪、会话增量扫描
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeUpstreamUsage, dayKey, createUsageStore, scanClaudeSessions,
} from '../src/main/engine/usage.js';

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
function near(a, b, label, tol = 1e-9) {
  if (Math.abs(Number(a) - Number(b)) < tol) { pass++; return; }
  fail++; failures.push(`${label}\n     期望: ${b}\n     实得: ${a}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-'));

// ---------- 1) token 口径换算 ----------
{
  // 上游 OpenAI 口径：prompt_tokens 含缓存命中
  const u = normalizeUpstreamUsage({
    prompt_tokens: 1000, completion_tokens: 200,
    prompt_tokens_details: { cached_tokens: 800 },
    cost: 0.0123,
  });
  eq(u.input, 200, '1.1 input 要扣掉缓存部分');
  eq(u.cacheRead, 800, '1.2 cacheRead 取 cached_tokens');
  eq(u.output, 200, '1.3 output 取 completion_tokens');
  eq(u.total, 1200, '1.4 total = prompt + completion');
  near(u.realCost, 0.0123, '1.5 真实成本取 usage.cost');
  ok(u.realCost !== null, '1.6 有 cost 字段时 realCost 不为空');

  // 没有 cost 字段时要给 null，不能给 0（0 会被当成「免费」）
  const u2 = normalizeUpstreamUsage({ prompt_tokens: 10, completion_tokens: 5 });
  eq(u2.realCost, null, '1.7 无 cost 字段时 realCost 必须是 null 而非 0');
  eq(u2.input, 10, '1.8 无缓存时 input = prompt');

  // gateway_cost 兜底
  const u3 = normalizeUpstreamUsage({ prompt_tokens: 1, completion_tokens: 1, gateway_cost: 0.5 });
  near(u3.realCost, 0.5, '1.9 cost 缺失时回落 gateway_cost');

  // 脏数据不能炸
  eq(normalizeUpstreamUsage(null), null, '1.10 null 输入返回 null');
  eq(normalizeUpstreamUsage('x'), null, '1.11 非对象输入返回 null');
  const u4 = normalizeUpstreamUsage({ prompt_tokens: 'abc', completion_tokens: -5 });
  eq(u4.input, 0, '1.12 非数字 prompt 归一成 0');
  eq(u4.output, -5, '1.13 负数原样（由上层决定是否过滤）');
}

// ---------- 2) 日期分桶用本地时区 ----------
{
  // 构造一个本地时间的深夜，检查不会被 UTC 推到前一天/后一天
  const d = new Date(2026, 8, 26, 23, 30, 0);   // 2026-09-26 23:30 本地
  eq(dayKey(d.getTime()), '2026-09-26', '2.1 深夜仍归本地当天');
  const d2 = new Date(2026, 0, 1, 0, 5, 0);
  eq(dayKey(d2.getTime()), '2026-01-01', '2.2 凌晨归本地当天且补零');
}

// ---------- 3) 定价查找与花费估算 ----------
{
  const store = createUsageStore(tmp, {});
  // 精确命中
  ok(store.lookupPricing('claude-opus-5'), '3.1 精确命中内置定价');
  // 带 provider 前缀要能剥掉
  const p1 = store.lookupPricing('deepseek/deepseek-v4-flash');
  ok(p1, '3.2 vendor/model 形式能命中');
  eq(p1.key, 'deepseek-v4-flash', '3.3 命中剥离前缀后的键');
  // 带日期后缀：能精确命中就用精确的
  const p2 = store.lookupPricing('claude-haiku-4-5-20251001');
  ok(p2, '3.4 带日期后缀能命中');
  // 去日期后缀是兜底路径：构造一个表里只有无后缀版本的键来验证它
  const store2 = createUsageStore(tmp, { pricing: { 'some-model': { i: 1, o: 2, cr: 0, cc: 0 } } });
  const p3 = store2.lookupPricing('some-model-20260101');
  ok(p3, '3.5a 精确找不到时剥离日期后缀能命中');
  eq(p3.key, 'some-model', '3.5b 命中剥离日期后的键');
  const p4 = store2.lookupPricing('some-model-2026-01-01');
  ok(p4, '3.5c 带完整日期的后缀也能剥离');
  // 找不到返回 null
  eq(store.lookupPricing('不存在的模型'), null, '3.6 未知模型返回 null');

  // 估算：Opus 5 定价 i=5 o=25 cr=0.5 cc=6.25（每百万）
  const est = store.estimateCost('claude-opus-5', {
    input: 1e6, output: 1e6, cacheRead: 1e6, cacheCreation: 1e6,
  });
  near(est.cost, 5 + 25 + 0.5 + 6.25, '3.7 估算把四类 token 都算进去', 1e-6);
  ok(est.estimated, '3.8 估算结果标记 estimated');
  // 未知模型不估算（而不是算成 0）
  eq(store.estimateCost('不存在', { input: 1e6 }), null, '3.9 未知模型不给估算值');
}

// ---------- 4) 汇总与去重 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'agg-'));
  const store = createUsageStore(dir, {});
  const base = { ts: new Date(2026, 8, 26, 10, 0, 0).getTime(), provider: 'deepseek', model: 'm', canonical: 'c', account: 'A' };

  eq(store.add({ ...base, id: 'r1', source: 'proxy', input: 100, output: 10, cacheRead: 5, cacheCreation: 0, cost: 0.01, costSource: 'real', ms: 100 }), true, '4.1 首次写入成功');
  eq(store.add({ ...base, id: 'r1', source: 'proxy', input: 100 }), false, '4.2 同 id 重复写入被拒');
  eq(store.add({ ...base, id: 'r2', source: 'session', input: 200, output: 20, cacheRead: 0, cacheCreation: 0, error: 'boom', ms: 300 }), true, '4.3 不同 id 可写入');

  const day = store.daily['2026-09-26'];
  ok(day, '4.4 生成了当天汇总');
  const keys = Object.keys(day.rollups);
  eq(keys.length, 1, '4.5 同一账号/渠道/模型归到一个桶');
  const r = day.rollups[keys[0]];
  eq(r.requests, 2, '4.6 请求数累计');
  eq(r.success, 1, '4.7 有 error 的不计入成功');
  eq(r.input, 300, '4.8 input 累加');
  eq(r.output, 30, '4.9 output 累加');
  eq(r.cacheRead, 5, '4.10 cacheRead 累加');
  near(r.cost, 0.01, '4.11 cost 累加');
  near(r.costReal, 0.01, '4.12 标记 real 的进 costReal');
  eq(r.msCount, 2, '4.13 有耗时的样本计数');
  eq(r.msSum, 400, '4.14 耗时累加');
  eq(r.bySource.proxy, 1, '4.15 bySource 按来源分别计数（proxy）');
  eq(r.bySource.session, 1, '4.16 bySource 按来源分别计数（session）');
}

// ---------- 5) 汇总维度：不同账号/渠道要分开 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'dim-'));
  const store = createUsageStore(dir, {});
  const ts = new Date(2026, 8, 26, 10, 0, 0).getTime();
  store.addMany([
    { ts, id: 'a', account: 'A', provider: 'p1', model: 'm', canonical: 'c', source: 'proxy', input: 1 },
    { ts, id: 'b', account: 'B', provider: 'p1', model: 'm', canonical: 'c', source: 'proxy', input: 2 },
    { ts, id: 'c', account: 'A', provider: 'p2', model: 'm', canonical: 'c', source: 'proxy', input: 4 },
  ]);
  const day = store.daily['2026-09-26'];
  eq(Object.keys(day.rollups).length, 3, '5.1 账号/渠道不同则分桶');
  const total = Object.values(day.rollups).reduce((n, r) => n + r.input, 0);
  eq(total, 7, '5.2 分散在三个桶里总计正确');
  // addMany 返回值 = 实际新增数
  eq(store.addMany([{ ts, id: 'a', input: 9 }]), 0, '5.3 addMany 跳过已存在的 id');
  eq(store.addMany([{ ts, id: 'z', account: 'A', provider: 'p1', model: 'm', canonical: 'c', source: 'proxy', input: 9 }]), 1, '5.4 addMany 返回新增条数');
}

// ---------- 6) 跨天分开 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'day-'));
  const store = createUsageStore(dir, {});
  store.add({ ts: new Date(2026, 8, 26, 23, 59, 0).getTime(), id: 'd1', source: 'proxy', input: 1 });
  store.add({ ts: new Date(2026, 8, 27, 0, 1, 0).getTime(), id: 'd2', source: 'proxy', input: 2 });
  eq(Object.keys(store.daily).length, 2, '6.1 跨天分成两个日期桶');
  ok(store.daily['2026-09-26'] && store.daily['2026-09-27'], '6.2 两个日期键都在');
}

// ---------- 7) 落盘与重载（模拟重启）----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'persist-'));
  const s1 = createUsageStore(dir, {});
  s1.add({ ts: Date.now(), id: 'p1', source: 'proxy', input: 42, account: 'A', provider: 'p', model: 'm', canonical: 'c' });
  s1.add({ ts: Date.now(), id: 'p2', source: 'proxy', input: 8, account: 'A', provider: 'p', model: 'm', canonical: 'c' });
  ok(fs.existsSync(s1.paths.DETAIL), '7.1 明细文件已落盘');
  ok(fs.existsSync(s1.paths.DAILY), '7.2 汇总文件已落盘');

  const s2 = createUsageStore(dir, {});
  eq(s2.lines, 0, '7.3 新实例初始未计行数');
  const primed = s2.prime();
  eq(primed.lines, 2, '7.4 prime 回填行数');
  eq(s2.has('p1'), true, '7.5 prime 之后能认出已有 id（去重跨重启有效）');
  ok(JSON.stringify(s2.daily).includes('"input":42') || JSON.stringify(s2.daily).includes('"input":50'), '7.6 汇总持久化后可读');
}

// ---------- 8) 明细裁剪 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'compact-'));
  const store = createUsageStore(dir, {});
  const old = Date.now() - 200 * 86400e3;
  store.addMany([
    { ts: old, id: 'old1', source: 'proxy', input: 1 },
    { ts: old, id: 'old2', source: 'proxy', input: 1 },
    { ts: Date.now(), id: 'new1', source: 'proxy', input: 1 },
  ]);
  const r = store.compact({ keepDays: 90 });
  eq(r.removed, 2, '8.1 裁掉超期明细');
  eq(r.kept, 1, '8.2 保留期内明细');
  const left = fs.readFileSync(store.paths.DETAIL, 'utf8').split('\n').filter(Boolean);
  eq(left.length, 1, '8.3 裁剪后文件只剩保留的行');
  ok(left[0].includes('new1'), '8.4 保留的是新记录');
}

// ---------- 9) 会话记录扫描 ----------
// 每个场景用独立的 projects 根目录 —— 生产环境确实是扫一个根下的所有项目，
// 但测试之间若共享根目录会互相捞到对方的文件。
{
  const dir = fs.mkdtempSync(path.join(tmp, 'scan-'));
  const mkRoot = (name) => { const p = path.join(dir, name); fs.mkdirSync(p, { recursive: true }); return p; };

  const rec = (id, inp, out, extra = {}) => JSON.stringify({
    type: 'assistant',
    timestamp: new Date(2026, 8, 26, 12, 0, 0).toISOString(),
    sessionId: 'sess-1',
    message: { id, model: 'cline-pass/deepseek-v4.1-flash', usage: { input_tokens: inp, output_tokens: out, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } },
    ...extra,
  });

  // --- 9a) 基本扫描 + 增量 ---
  {
    const projects = mkRoot('p-basic');
    const projDir = path.join(projects, 'C--Users-x-Desktop-demo');
    fs.mkdirSync(projDir, { recursive: true });
    const store = createUsageStore(path.join(dir, 'data-basic'), {});
    const f1 = path.join(projDir, 'sess-1.jsonl');
    fs.writeFileSync(f1, [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),   // 没有 usage，应被跳过
      rec('gen_1', 100, 20),
      JSON.stringify({ type: 'assistant', message: { id: 'synth', model: '<synthetic>', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),  // 全 0，跳过
      rec('gen_2', 200, 40),
    ].join('\n') + '\n');

    const sync = { files: {} };
    const r1 = scanClaudeSessions({ projectsDir: projects, sync, store });
    eq(r1.added, 2, '9.1 扫出 2 条有 token 的 assistant 记录');
    eq(r1.skipped, 0, '9.2 首次扫描没有跳过项');
    const day = store.daily['2026-09-26'];
    eq(day.rollups[Object.keys(day.rollups)[0]].input, 300, '9.3 token 累加正确');

    // 增量：再扫一次不该重复
    const r2 = scanClaudeSessions({ projectsDir: projects, sync, store });
    eq(r2.added, 0, '9.4 增量扫描不重复计入');
    eq(r2.files, 0, '9.5 没有新字节时不重扫文件');

    // 追加新记录后只读新增部分
    fs.appendFileSync(f1, rec('gen_3', 50, 5) + '\n');
    const r3 = scanClaudeSessions({ projectsDir: projects, sync, store });
    eq(r3.added, 1, '9.6 追加后只扫新增记录');
    eq(store.has('gen_3'), true, '9.7 新记录已入库');

    // 会话记录要按定价表估算成本（否则用户看到 $0 会以为免费）
    {
      const rr0 = day.rollups[Object.keys(day.rollups)[0]];
      ok(rr0.costEstimated > 0, '会话记录的成本按定价表估算出来了', 'costEstimated=' + rr0.costEstimated);
      eq(rr0.costReal, 0, '会话记录不冒充真实成本');
      const recs = fs.readFileSync(store.paths.DETAIL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      ok(recs.every((x) => x.costSource === 'estimated'), '会话记录标记为 estimated');
    }

    // 会话记录里的账号/渠道是未知的 —— 不能编造
    const rr = day.rollups[Object.keys(day.rollups)[0]];
    eq(rr.account, null, '9.8 会话记录不带账号（不编造）');
    eq(rr.provider, null, '9.9 会话记录不带渠道（不编造）');
  }

  // --- 9b) 与代理日志去重 ---
  {
    const projects = mkRoot('p-dedup');
    const store2 = createUsageStore(path.join(dir, 'data-dedup'), {});
    const p2 = path.join(projects, 'proj');
    fs.mkdirSync(p2, { recursive: true });
    store2.add({ ts: Date.now(), id: 'gen_9', source: 'proxy', input: 1 });
    fs.writeFileSync(path.join(p2, 's.jsonl'), rec('gen_9', 999, 999) + '\n' + rec('gen_10', 1, 1) + '\n');
    const r4 = scanClaudeSessions({ projectsDir: projects, sync: { files: {} }, store: store2 });
    eq(r4.skipped, 1, '9.10 已被代理记录的请求在扫描时被跳过');
    eq(r4.added, 1, '9.11 只有未记录过的那条入库');
    eq(store2.has('gen_10'), true, '9.12 未重复的记录正常入库');
  }

  // --- 9c) 半行（正在写入）不消费、不丢数据 ---
  {
    const projects = mkRoot('p-partial');
    const store3 = createUsageStore(path.join(dir, 'data-partial'), {});
    const p3 = path.join(projects, 'proj');
    fs.mkdirSync(p3, { recursive: true });
    const f3 = path.join(p3, 's.jsonl');
    fs.writeFileSync(f3, rec('gen_a', 10, 1) + '\n' + rec('gen_b', 20, 2));   // 最后一行无换行

    const sync3 = { files: {} };
    const r5 = scanClaudeSessions({ projectsDir: projects, sync: sync3, store: store3 });
    eq(r5.added, 1, '9.13 不完整末行不消费');
    eq(store3.has('gen_b'), false, '9.14 半行里的 id 没被提前计入');

    fs.appendFileSync(f3, '\n');                  // 行写完了
    const r7 = scanClaudeSessions({ projectsDir: projects, sync: sync3, store: store3 });
    eq(r7.added, 1, '9.15 补全末行后能读到第二条');
    eq(store3.has('gen_b'), true, '9.16 补全后 id 入库');
  }

  // --- 9d) 文件被截断/重写 ---
  {
    const projects = mkRoot('p-trunc');
    const sync8 = { files: {} };
    const store8 = createUsageStore(path.join(dir, 'data-trunc'), {});
    const p8 = path.join(projects, 'proj');
    fs.mkdirSync(p8, { recursive: true });
    const f8 = path.join(p8, 's.jsonl');
    fs.writeFileSync(f8, rec('t1', 1, 1) + '\n' + rec('t2', 1, 1) + '\n');
    scanClaudeSessions({ projectsDir: projects, sync: sync8, store: store8 });
    fs.writeFileSync(f8, rec('t3', 5, 5) + '\n');    // 重写成更短的内容
    const r9 = scanClaudeSessions({ projectsDir: projects, sync: sync8, store: store8 });
    eq(r9.added, 1, '9.17 文件变短后从头重扫');
    eq(store8.has('t3'), true, '9.18 重写后的新记录被读到');
  }

  // --- 9e) 边界 ---
  {
    const projects = mkRoot('p-edge');
    const store4 = createUsageStore(path.join(dir, 'data-edge'), {});

    // 不存在的目录不炸
    const r10 = scanClaudeSessions({ projectsDir: path.join(dir, 'nope'), sync: { files: {} }, store: store4 });
    eq(r10.added, 0, '9.19 目录不存在时安全返回');

    // 坏 JSON 行不能中断整个扫描
    const pBad = path.join(projects, 'proj');
    fs.mkdirSync(pBad, { recursive: true });
    fs.writeFileSync(path.join(pBad, 's.jsonl'),
      '{坏行\n' + rec('good_1', 7, 3) + '\n' + 'not json at all\n');
    const r11 = scanClaudeSessions({ projectsDir: projects, sync: { files: {} }, store: store4 });
    eq(r11.added, 1, '9.20 坏行被跳过但好行仍入库');
    eq(store4.has('good_1'), true, '9.21 坏行之后的好记录被读到');

    // 非 .jsonl 文件不该被当作会话记录
    fs.writeFileSync(path.join(pBad, 'notes.txt'), rec('nope_1', 1, 1) + '\n');
    const r12 = scanClaudeSessions({ projectsDir: projects, sync: { files: {} }, store: store4 });
    eq(store4.has('nope_1'), false, '9.22 非 .jsonl 文件不参与扫描');
  }
}

// ---------- 10) 汇总统计读取 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'sum-'));
  const store = createUsageStore(dir, {});
  const t1 = new Date(2026, 8, 26, 10, 0, 0).getTime();
  const t2 = new Date(2026, 8, 27, 10, 0, 0).getTime();
  store.addMany([
    { ts: t1, id: 'x1', source: 'proxy', account: 'A', provider: 'p', model: 'm', canonical: 'c', input: 1000, output: 100, cacheRead: 500, cost: 0.5, costSource: 'real', ms: 200, firstTokenMs: 100 },
    { ts: t1, id: 'x2', source: 'session', account: 'A', provider: 'p', model: 'm', canonical: 'c', input: 2000, output: 200, cacheRead: 0, cost: 0.25, costSource: 'estimated', ms: 400 },
    { ts: t2, id: 'x3', source: 'proxy', account: 'A', provider: 'p', model: 'm', canonical: 'c', input: 500, output: 50, cacheRead: 0 },
  ]);
  const days = Object.keys(store.daily).sort();
  eq(days.length, 2, '10.1 两天的汇总都在');
  const d1 = store.daily['2026-09-26'].rollups;
  const r = d1[Object.keys(d1)[0]];
  eq(r.requests, 2, '10.2 第一天两条');
  eq(r.input, 3000, '10.3 第一天 input 合计');
  eq(r.cacheRead, 500, '10.4 第一天 cacheRead 合计');
  near(r.costReal, 0.5, '10.5 真实成本单列');
  near(r.costEstimated, 0.25, '10.6 估算成本单列');
  eq(r.firstTokenCount, 1, '10.7 首字延迟样本计数');
  eq(r.firstTokenSum, 100, '10.8 首字延迟累加');
  ok(r.bySource.proxy === 1 && r.bySource.session === 1, '10.9 按来源分别计数');
}

// ---------- 11) 坏数据不破坏已有数据 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'bad-'));
  const store = createUsageStore(dir, {});
  store.add({ ts: Date.now(), id: 'good', source: 'proxy', input: 1 });
  // 手工塞一行坏 JSON
  fs.appendFileSync(store.paths.DETAIL, '{这不是合法 JSON\n');
  const r = store.compact({ keepDays: 3650 });
  eq(r.removed, 1, '11.1 裁剪时坏行被剔除');
  eq(r.kept, 1, '11.2 好行保留');
  const left = fs.readFileSync(store.paths.DETAIL, 'utf8');
  ok(left.includes('good'), '11.3 好数据没被坏行带走');
}

// ---------- 12) 自定义定价覆盖内置 ----------
{
  const dir = fs.mkdtempSync(path.join(tmp, 'price-'));
  fs.writeFileSync(path.join(dir, 'pricing.json'), JSON.stringify({
    'claude-opus-5': { i: 1, o: 2, cr: 0.1, cc: 0.2 },
    '我的自建模型': { i: 9, o: 9, cr: 0, cc: 0 },
  }));
  const store = createUsageStore(dir, {});
  const p = store.lookupPricing('claude-opus-5');
  eq(p.i, 1, '12.1 自定义定价覆盖内置同名项');
  const est = store.estimateCost('我的自建模型', { input: 1e6, output: 0, cacheRead: 0, cacheCreation: 0 });
  near(est.cost, 9, '12.2 自定义模型可估算');
}

fs.rmSync(tmp, { recursive: true, force: true });

// ---------- 结果 ----------
console.log(`\n用量统计核心模块：${pass} 项通过，${fail} 项失败`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('全部通过 ✓');
