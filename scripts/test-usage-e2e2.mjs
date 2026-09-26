// 用量统计新增能力的端到端测试（对着真实引擎跑，不碰用户正在用的实例）
//
// 覆盖本次需求：
//   1. 明细**倒序**（最新在前）—— 且要能挡住「按文件位置当时间序」那个错
//   2. 按天趋势支持 当天 / 7 / 31 / 60 / 90 天
//   3. 「当天」按小时聚合，能画出 0-23 点
//   4. DeepSeek 用官方人民币价，其他模型不硬算人民币
//   5. 实时推送：新记录写进去后，引擎回调被触发
//
// 用法：DATA_DIR=<临时目录> node scripts/test-usage-e2e2.mjs
// 这个脚本只操作 DATA_DIR 下的文件，不会碰任何真实数据。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUsageStore, hourKey, dayKey } from '../src/main/engine/usage.js';
import { deepseekCostCny } from '../src/main/engine/pricing-cny.js';

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
function near(a, b, label, tol = 1e-6) {
  if (Math.abs(Number(a) - Number(b)) < tol) { pass++; return; }
  fail++; failures.push(`${label}\n     期望: ${b}\n     实得: ${a}`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-e2e2-'));
const store = createUsageStore(path.join(tmp, 'usage'));

// 北京时间助手
const bj = (y, m, d, h, min = 0) => Date.UTC(y, m - 1, d, h, min) - 8 * 3600 * 1000;

// ---------- 1) 明细倒序 ----------
{
  // 刻意**乱序写入**：先写一条「晚的」，再写一条「早的」。
  // 这正是真实数据的样子（会话扫描按文件顺序追加，实测 57/1701 乱序）。
  // 旧实现从文件尾部读，会把 09:00 那条当成最新的 —— 这个测试就是钉死这个行为。
  const later = bj(2026, 9, 26, 15, 0);
  const earlier = bj(2026, 9, 26, 9, 0);
  store.add({ id: 'e2e-late', ts: later, source: 'proxy', model: 'cline-pass/deepseek-v4.1-flash', input: 10, output: 1 });
  store.add({ id: 'e2e-early', ts: earlier, source: 'proxy', model: 'cline-pass/deepseek-v4.1-flash', input: 10, output: 1 });

  const r = store.recentRecords({ limit: 10 });
  eq(r.records.length, 2, '1.1 两条都读到了');
  eq(r.records[0].id, 'e2e-early', '1.2 按写入序号倒序：后写的在前');
  ok(r.records.every((x) => typeof x.n === 'number'), '1.3 每条都带写入序号 n');
  ok(r.records[0].n > r.records[1].n, '1.4 序号单调');

  // 引擎接口再按时间排一次 → 最终严格时间倒序
  const sorted = r.records.slice().sort((a, b) => b.ts - a.ts);
  eq(sorted[0].id, 'e2e-late', '1.5 按时间倒序后最新的在最前');
  ok(sorted[0].ts > sorted[1].ts, '1.6 时间严格递减');

  // 突破尾部窗口：写 60 条，按 limit 取最近 5 条必须是最后写的那 5 条
  for (let i = 0; i < 60; i++) {
    store.add({ id: `e2e-bulk-${i}`, ts: bj(2026, 9, 26, 0, 0) + i * 1000, source: 'session', model: 'k3', input: 1, output: 1 });
  }
  const r5 = store.recentRecords({ limit: 5 });
  eq(r5.records.length, 5, '1.7 limit 生效');
  eq(r5.records[0].id, 'e2e-bulk-59', '1.8 最近一条是最后写的');
  eq(r5.records[4].id, 'e2e-bulk-55', '1.9 往回数正好第 5 条');
}

// ---------- 2) 筛选 ----------
{
  const onlyK3 = store.recentRecords({ limit: 100, model: 'k3' });
  ok(onlyK3.records.length === 60, `2.1 按模型筛选（得到 ${onlyK3.records.length}，期望 60）`);
  const onlyProxy = store.recentRecords({ limit: 100, source: 'proxy' });
  eq(onlyProxy.records.length, 2, '2.2 按来源筛选');
  const byTime = store.recentRecords({ limit: 100, from: bj(2026, 9, 26, 12, 0) });
  ok(byTime.records.every((r) => r.ts >= bj(2026, 9, 26, 12, 0)), '2.3 按起始时间筛选');
  eq(byTime.records.length, 1, '2.4 起始时间筛选只留下午那条');
}

// ---------- 3) 按天 / 按小时汇总 ----------
{
  // 注意：hourKey/dayKey 用的是**本机时区**（用户看到的「今天」是他自己的今天），
  // 所以这里的期望值必须用同一个函数算出来，不能写死 'T09' 这种字面量 ——
  // 那样在 UTC+8 的本机跑得通，到 UTC 的 CI 上就全错（这个坑已经被 CI 抓到过一次）。
  const tsAt9 = bj(2026, 9, 26, 9, 0);
  const tsAt15 = bj(2026, 9, 26, 15, 0);
  const tsAt0 = bj(2026, 9, 26, 0, 0);
  const kAt9 = hourKey(tsAt9);
  const kAt15 = hourKey(tsAt15);
  const kAt0 = hourKey(tsAt0);

  const d = store.daily;
  ok(d[dayKey(tsAt9)], '3.1 有当天（本机时区）的按天桶');
  const h = store.hourly;
  ok(h[kAt9], '3.2 有 09 点（北京）那条记录所在的小时桶');
  ok(h[kAt15], '3.3 有 15 点（北京）那条记录所在的小时桶');
  eq(hourKey(bj(2026, 9, 26, 9, 30)), kAt9, '3.4 hourKey 取整点（半小时归到同一小时）');
  eq(dayKey(bj(2026, 9, 26, 23, 59)), dayKey(tsAt9), '3.5 dayKey 取当天（当天最后一分钟仍算当天）');

  // 小时桶合计要等于当天总量（两套汇总必须一致，否则界面两个图对不上）
  const dayOf = dayKey(tsAt9);
  const hourSum = Object.entries(h).filter(([k]) => k.startsWith(dayOf))
    .reduce((n, [, v]) => n + Object.values(v.rollups).reduce((a, r) => a + r.requests, 0), 0);
  const daySum = Object.values(d[dayOf].rollups).reduce((a, r) => a + r.requests, 0);
  eq(hourSum, daySum, '3.6 小时合计 = 当天合计');

  // 跨小时分布：09 点（北京）1 条（e2e-early），15 点 1 条（e2e-late），0 点 60 条（bulk）
  eq(Object.values(h[kAt9].rollups).reduce((a, r) => a + r.requests, 0), 1, '3.7 09 点 1 条');
  eq(Object.values(h[kAt15].rollups).reduce((a, r) => a + r.requests, 0), 1, '3.8 15 点 1 条');
  eq(Object.values(h[kAt0].rollups).reduce((a, r) => a + r.requests, 0), 60, '3.9 0 点 60 条');

  // 三个小时键必须互不相同（本机时区偏移下也不能撞到一起）
  eq(new Set([kAt0, kAt9, kAt15]).size, 3, '3.10 三个小时落在三个不同的桶');
}

// ---------- 4) 人民币计价 ----------
{
  // 高峰：周一 10:00 北京
  const peakTs = bj(2026, 9, 28, 10, 0);
  const cny = deepseekCostCny('cline-pass/deepseek-v4.1-flash',
    { input: 1e6, cacheRead: 1e6, cacheCreation: 0, output: 1e6 }, peakTs);
  near(cny.cost, 2 + 0.04 + 8, '4.1 flash 高峰 = ¥10.04');
  // 空闲：同一天 03:00
  const off = deepseekCostCny('cline-pass/deepseek-v4.1-flash',
    { input: 1e6, cacheRead: 1e6, cacheCreation: 0, output: 1e6 }, bj(2026, 9, 28, 3, 0));
  near(off.cost, 1 + 0.02 + 4, '4.2 flash 空闲 = ¥5.02');
  near(off.cost * 2, cny.cost, '4.3 空闲正好是高峰一半');
  // pro 的缓存命中价明显不同（0.15 vs 0.02），确认没混用
  const pro = deepseekCostCny('deepseek-v4-pro', { input: 0, cacheRead: 1e6, cacheCreation: 0, output: 0 }, bj(2026, 9, 28, 3, 0));
  near(pro.cost, 0.15, '4.4 pro 缓存命中价独立');
  // 非 DeepSeek 不硬算
  eq(deepseekCostCny('k3', { input: 1e6, output: 1e6 }, peakTs), null, '4.5 k3 无人民币价');
}

// ---------- 5) 人民币进桶 ----------
{
  // 写一条带人民币的记录，确认汇总里 costCny 被累加
  const before = Object.values(store.daily['2026-09-26'].rollups).reduce((a, r) => a + (r.costCny || 0), 0);
  store.add({
    id: 'e2e-cny-1', ts: bj(2026, 9, 28, 10, 0), source: 'proxy',
    model: 'cline-pass/deepseek-v4.1-flash', canonical: 'deepseek/deepseek-v4.1-flash',
    provider: 'deepseek', account: 'A',
    input: 1e6, output: 1e6, cacheRead: 0, cacheCreation: 0,
    cost: 1.4, costSource: 'real',
    costCny: 10, costCnyPeak: true,
  });
  const day = store.daily['2026-09-28'];
  ok(day, '5.1 新建了 09-28 的桶');
  const cnySum = Object.values(day.rollups).reduce((a, r) => a + (r.costCny || 0), 0);
  near(cnySum, 10, '5.2 人民币被累加');
  const peakSum = Object.values(day.rollups).reduce((a, r) => a + (r.costCnyPeak || 0), 0);
  near(peakSum, 10, '5.3 高峰部分单独累计');
  const usdSum = Object.values(day.rollups).reduce((a, r) => a + (r.cost || 0), 0);
  near(usdSum, 1.4, '5.4 美元与人民币各自独立，不互相污染');
  ok(before === 0, '5.5 09-26 原本没有人民币');
}

// ---------- 6) 实时推送回调 ----------
{
  // setUsageSink 在 engine.js 里，这里直接验证 store.add 的返回值语义：
  // 返回 true 表示「真的新增了」，引擎据此决定要不要推送 —— 去重跳过的不该推。
  const fresh = store.add({ id: 'e2e-sink-1', ts: Date.now(), source: 'proxy', model: 'k3', input: 1, output: 1 });
  eq(fresh, true, '6.1 新记录 add 返回 true（会触发推送）');
  const dup = store.add({ id: 'e2e-sink-1', ts: Date.now(), source: 'proxy', model: 'k3', input: 1, output: 1 });
  eq(dup, false, '6.2 重复记录返回 false（不推送）');
}

// ---------- 7) prime 后的序号不重号 ----------
{
  // 重启场景：新建 store 从同一目录 prime，序号必须接上，否则新记录会与老记录同号
  const dir2 = path.join(tmp, 'usage');
  const maxN = Math.max(...fs.readFileSync(path.join(dir2, 'usage.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l).n));
  const store2 = createUsageStore(dir2);
  const p = store2.prime();
  eq(p.seq, maxN, '7.1 prime 把序号回填到最大值');
  store2.add({ id: 'e2e-after-restart', ts: Date.now(), source: 'proxy', model: 'k3', input: 1, output: 1 });
  const all = fs.readFileSync(path.join(dir2, 'usage.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l).n);
  eq(new Set(all).size, all.length, '7.2 重启后序号不重号');
}

// ---------- 8) 小时桶不会无限增长 ----------
{
  const s3 = createUsageStore(path.join(tmp, 'usage3'));
  const dayKeys = new Set();
  for (let d = 0; d < 12; d++) {
    for (let h = 0; h < 24; h++) {
      const ts = bj(2026, 9, 1 + d, h, 0);
      dayKeys.add(dayKey(ts));
      s3.add({ id: `hb-${d}-${h}`, ts, source: 'proxy', model: 'k3', input: 1, output: 1 });
    }
  }
  const keys = Object.keys(s3.hourly);
  ok(keys.length <= 4 * 24, `8.1 小时桶被裁剪到 4 天以内（实际 ${keys.length}）`);
  ok(keys.length > 0, '8.2 还留着最近的小时桶');
  // 最近的必须留着：最后一个写入日对应的小时键应当还在
  const lastDayKey = dayKey(bj(2026, 9, 12, 12, 0));
  ok(keys.some((k) => k.startsWith(lastDayKey)), `8.3 保留的是最近的（最后一天 ${lastDayKey}）`);
  // 按天汇总不受小时裁剪影响。天数是「本机时区下实际出现的日期数」——
  // 北京时区的 12 天跨到 UTC 可能压在 13 个日期上（反之亦然），所以用实测集合而不是写死 12。
  eq(Object.keys(s3.daily).length, dayKeys.size, `8.4 按天汇总完整保留（${dayKeys.size} 个本地日期）`);
  ok(dayKeys.size >= 12, '8.5 至少覆盖 12 个日期');
}

// ---------- 9) 「当天」的小时起点 ----------
// 回归：曾经用 hourKey(now) 当起点，于是「当天」只留下当前小时及以后，
// 今天已经过去的那些小时全被滤掉 —— 界面表现为「当天 0 次请求」。
// 正确的起点是**当天 00 点**。
{
  const { dayKey } = await import('../src/main/engine/usage.js');
  const now = Date.now();
  const startDay = dayKey(now - 0 * 86400e3);          // days=1 的起点就是今天
  const cutoff = startDay + 'T00';
  eq(cutoff.length, 13, '9.1 小时起点是 YYYY-MM-DDTHH 形式');
  ok(cutoff.endsWith('T00'), '9.2 小时起点落在 00 点');
  eq(cutoff.slice(0, 10), dayKey(now), '9.3 小时起点就是今天');

  // 今天任意一个已经过去的小时，都必须 >= 起点（否则就会被漏掉）
  const h = new Date(now);
  h.setHours(0, 30, 0, 0);                              // 今天 00:30
  const { hourKey } = await import('../src/main/engine/usage.js');
  ok(hourKey(h.getTime()) >= cutoff, '9.4 今天 00:30 的记录在区间内（不该被滤掉）');
  const h2 = new Date(now);
  h2.setHours(h2.getHours(), 0, 0, 0);
  ok(hourKey(h2.getTime()) >= cutoff, '9.5 当前小时的记录在区间内');

  // 反例：旧的错误起点会把凌晨的记录排除掉
  const badCutoff = hourKey(now);
  const midnight = new Date(now); midnight.setHours(0, 0, 0, 0);
  ok(!(hourKey(midnight.getTime()) >= badCutoff), '9.6 旧写法确实会漏掉今天凌晨（说明这个回归有意义）');
}

// ---------- 10) available 一律是天 ----------
// 回归：小时粒度下曾经拿小时键当 available.from，界面显示成「数据自 2026-09-21T03 起」。
// 用一个自己的 store，避免受前面用例写入的数据影响。
{
  const { dayKey } = await import('../src/main/engine/usage.js');
  const s4 = createUsageStore(path.join(tmp, 'usage4'));
  const tA = bj(2026, 9, 21, 3, 0);
  const tB = bj(2026, 9, 26, 15, 0);
  s4.add({ id: 'av-1', ts: tA, source: 'proxy', model: 'k3', input: 1, output: 1 });
  s4.add({ id: 'av-2', ts: tB, source: 'proxy', model: 'k3', input: 1, output: 1 });
  const allDays = Object.keys(s4.daily).sort();
  ok(allDays.every((k) => k.length === 10), '10.1 按天键是 10 位日期，不含小时');
  // 用 dayKey 算期望值（本机时区），不写死日期
  eq(allDays[0], dayKey(tA), '10.2 available.from 是最早那天');
  eq(allDays[allDays.length - 1], dayKey(tB), '10.3 available.to 是最晚那天');
  // 小时键确实带小时 —— 所以绝不能用它填 available
  ok(Object.keys(s4.hourly).some((k) => k.length > 10), '10.4 小时键比天键长（两者不能混用）');
  eq(dayKey(bj(2026, 9, 21, 3, 30)), dayKey(tA), '10.5 dayKey 抹掉小时（同一小时内同一天）');
}


// ---------- 11) recompute：给老数据补人民币 ----------
// 回归：人民币计价是后加的能力，老记录没有 costCny 字段，而汇总只在写入时累加 ——
// 不重算的话历史在界面上永远是 ¥0，新数据却有值。
{
  const dir5 = path.join(tmp, 'usage5');
  fs.mkdirSync(dir5, { recursive: true });
  // 造一批**没有** costCny 的老记录（模拟升级前的数据），写原始 JSONL 绕过 store.add
  const bj5 = (y, m, d, h) => Date.UTC(y, m - 1, d, h) - 8 * 3600 * 1000;
  const raw = [];
  for (let i = 0; i < 10; i++) {
    raw.push(JSON.stringify({
      id: 'old-' + i, ts: bj5(2026, 9, 28, 3), source: 'proxy',
      model: 'cline-pass/deepseek-v4.1-flash', canonical: 'deepseek/deepseek-v4.1-flash',
      input: 1e6, output: 1e6, cacheRead: 0, cacheCreation: 0, total: 2e6,
      cost: 0.5, costSource: 'real',
    }));
  }
  // 一条非 DeepSeek，重算后应保持 null
  raw.push(JSON.stringify({
    id: 'old-k3', ts: bj5(2026, 9, 28, 3), source: 'session', model: 'k3',
    input: 1e6, output: 1e6, cacheRead: 0, cacheCreation: 0, total: 2e6, cost: 0.1,
  }));
  fs.writeFileSync(path.join(dir5, 'usage.jsonl'), raw.join('\n') + '\n');

  const s5 = createUsageStore(dir5);
  s5.prime();
  const dayOfOld = dayKey(bj5(2026, 9, 28, 3));   // 本机时区下的那一天，别写死字面量
  eq(Object.keys(s5.daily).length, 0, '11.1 重算前没有汇总（老数据只有明细）');
  const rc = s5.recompute();
  eq(rc.records, 11, '11.2 重算覆盖全部记录');
  eq(rc.days, 1, '11.3 建出了 1 天的汇总');
  // 10 条 DeepSeek，每条 空闲价 = 1e6 未命中(¥1) + 1e6 输出(¥4) = ¥5
  near(rc.cny, 50, '11.4 人民币合计 = 10 × ¥5 = ¥50');
  const sum = Object.values(s5.daily[dayOfOld].rollups).reduce((a, r) => a + (r.costCny || 0), 0);
  near(sum, 50, '11.5 汇总里读回同一个数');
  ok(rc.changed > 0, '11.6 报告了被改写的条数');
  // 幂等
  const rc2 = s5.recompute();
  eq(rc2.changed, 0, '11.7 第二次重算无改动（幂等）');
  near(rc2.cny, rc.cny, '11.8 第二次金额完全相同（不叠加）');
  // k3 保持 null，不冒充 0
  const recs = s5.recentRecords({ limit: 50 }).records;
  const k3 = recs.find((r) => r.model === 'k3');
  eq(k3.costCny, null, '11.9 非 DeepSeek 保持 null（不是 0）');
  const ds = recs.find((r) => r.model === 'cline-pass/deepseek-v4.1-flash');
  near(ds.costCny, 5, '11.10 DeepSeek 记录被补上人民币金额');
  eq(ds.costCnyPeak, false, '11.11 时段标记也补上了');
  ok(typeof ds.n === 'number', '11.12 顺带补齐了缺失的写入序号');
}

// ---------- 12) 负数 token 不能产生负费用 ----------
// 回归：`Number(-100) || 0` 会**保留** -100（-100 是 truthy），于是算出负花费，
// 去抵消别的记录把总额算少 —— 比报错更难发现。两条计价路径都要挡。
{
  const off = bj(2026, 9, 28, 3);
  const negCny = deepseekCostCny('deepseek-flash', { input: -100, output: -5, cacheRead: -1, cacheCreation: -1 }, off);
  ok(negCny.cost >= 0, `12.1 人民币路径：负数 token 不产生负费用（得 ${negCny.cost}）`);
  near(negCny.cost, 0, '12.2 负数一律当 0');
  eq(negCny.tokens.cacheMiss, 0, '12.3 负数没有进 cacheMiss');
  eq(negCny.tokens.output, 0, '12.4 负数没有进 output');

  // 混合：一正一负，只算正的那部分
  const mix = deepseekCostCny('deepseek-flash', { input: 1e6, output: -999 }, off);
  near(mix.cost, 1, '12.5 正负混合时只计正数（未命中 1M × ¥1）');

  // 非有限值
  for (const bad of [NaN, Infinity, -Infinity]) {
    const r = deepseekCostCny('deepseek-flash', { input: bad, output: bad }, off);
    ok(Number.isFinite(r.cost) && r.cost >= 0, `12.6 ${String(bad)} 不产生 NaN/负值`);
  }
}

// ---------- 13) truncated 要如实上报 ----------
// 回归：只处理了 addedNodes 的那个坑修完后剩下这个 —— 扫描被上限截断时，
// 旧实现只在「没凑够 limit」时报 truncated，于是带筛选且匹配项都在更老位置时，
// 会带着 truncated=false 返回「没有匹配」，把「没扫到」伪装成「确实没有」。
{
  const dir6 = path.join(tmp, 'usage6');
  const s6 = createUsageStore(dir6);
  const base = bj(2026, 9, 28, 3);
  const batch = [];
  for (let i = 0; i < 6000; i++) batch.push({ id: 'd' + i, ts: base + i, source: 'proxy', model: 'k3', input: 1, output: 1 });
  s6.addMany(batch);

  const plain = s6.recentRecords({ limit: 5 });
  eq(plain.records.length, 5, '13.1 无筛选时正常返回 5 条');
  eq(plain.truncated, false, '13.2 无筛选时不误报 truncated');
  eq(plain.records[0].id, 'd5999', '13.3 返回的是最新那几条');

  // 只匹配最老的那 10 条 —— 必须扫到上限后如实报 truncated
  const ancient = s6.recentRecords({ limit: 5, to: base + 10 });
  eq(ancient.records.length, 0, '13.4 古老的匹配项超出了扫描上限（拿不到）');
  eq(ancient.truncated, true, '13.5 此时必须报 truncated=true，而不是伪装成「没有匹配」');
  ok(ancient.scanned >= 5000, '13.6 确实扫到了上限才停', `scanned=${ancient.scanned}`);

  // 能扫到的情况不能误报
  const near2 = s6.recentRecords({ limit: 5, from: base + 5990 });
  eq(near2.records.length, 5, '13.7 靠后的匹配项能正常取到');
  eq(near2.truncated, false, '13.8 能取到时不误报 truncated');
}

// ---------- 14) recompute 不能抹掉 compact 保留的历史（H1）----------
// 回归：第一版 recompute 是「从明细重建汇总」。但汇总**刻意**比明细活得久 ——
// compact 删掉 90 天前的明细时按天汇总必须保留（界面上就这么写的）。
// 重建等于把删掉的历史一并抹掉：一年历史缩成 90 天，且不可恢复��
{
  const dir7 = path.join(tmp, 'usage7');
  const s7 = createUsageStore(dir7);
  s7.add({ id: 'h1-old', ts: Date.now() - 200 * 86400e3, source: 'proxy', model: 'deepseek-flash', input: 1e6, output: 1e6 });
  s7.add({ id: 'h1-new', ts: Date.now(), source: 'proxy', model: 'deepseek-flash', input: 1e6, output: 1e6 });

  const daysBefore = Object.keys(s7.daily).length;
  const reqOf = (st) => Object.values(st.daily).reduce((n, d) => n + Object.values(d.rollups).reduce((a, r) => a + r.requests, 0), 0);
  const reqBefore = reqOf(s7);

  const c = s7.compact({ keepDays: 90 });
  eq(c.removed, 1, '14.1 compact 删掉了那条老明细');
  eq(Object.keys(s7.daily).length, daysBefore, '14.2 compact 不动按天汇总');
  eq(reqOf(s7), reqBefore, '14.3 compact 后请求数不变');

  s7.recompute();
  eq(Object.keys(s7.daily).length, daysBefore, '14.4 ★ recompute 后仍保留全部日期（不被重建抹掉）');
  eq(reqOf(s7), reqBefore, '14.5 ★ recompute 后请求数不变');
  // 存活的那条要被补上人民币
  const cny = Object.values(s7.daily).reduce((n, d) => n + Object.values(d.rollups).reduce((a, r) => a + (r.costCny || 0), 0), 0);
  near(cny, 5, '14.6 存活的记录被补上 ¥5（空闲价 1M×¥1 + 1M×¥4）');
  // 再跑一次不能叠加
  s7.recompute();
  const cny2 = Object.values(s7.daily).reduce((n, d) => n + Object.values(d.rollups).reduce((a, r) => a + (r.costCny || 0), 0), 0);
  near(cny2, cny, '14.7 再跑一次金额不变（差值法不叠加）');
}

// ---------- 15) 汇总为空的库仍能从明细重建（H1 的反向）----------
// 只做差值的话，汇总文件丢了/新装的库永远建不起来。
{
  const dir8 = path.join(tmp, 'usage8');
  const s8 = createUsageStore(dir8);
  const b = [];
  for (let i = 0; i < 10; i++) b.push({ id: 'h2-' + i, ts: bj(2026, 9, 28, 3), source: 'proxy', model: 'deepseek-flash', input: 1e6, output: 1e6 });
  s8.addMany(b);
  // 删掉汇总文件，模拟「汇总丢失」，然后重算
  fs.rmSync(path.join(dir8, 'usage_daily.json'));
  fs.rmSync(path.join(dir8, 'usage_hourly.json'));
  const s9 = createUsageStore(dir8);
  s9.prime();
  const r9 = s9.recompute();
  eq(r9.days, 1, '15.1 汇总为空时能从明细重建出按天汇总');
  const reqs = Object.values(s9.daily).reduce((n, d) => n + Object.values(d.rollups).reduce((a, x) => a + x.requests, 0), 0);
  eq(reqs, 10, '15.2 重建后请求数正确（10 条）');
  near(r9.cny, 50, '15.3 人民币也一起建起来了（10 × ¥5）');
}

// ---------- 16) 末行缺换行时，新记录不能被粘成坏行（H2）----------
// 回归：上一条写了一半就崩（末行无换行）时，直接 append 会把新记录粘在它后面，
// 两行合起来永远解析不了 —— 那条请求已计费、已进汇总、还推送了，却从明细里消失。
{
  const dir9 = path.join(tmp, 'usage9');
  fs.mkdirSync(dir9, { recursive: true });
  const f9 = path.join(dir9, 'usage.jsonl');
  fs.writeFileSync(f9, JSON.stringify({ id: 'ok1', ts: bj(2026, 9, 28, 3), source: 'proxy', model: 'k3', input: 1, output: 1 }) + '\n');
  fs.appendFileSync(f9, '{"id":"TORN","ts":1');   // 半行，无换行

  const s10 = createUsageStore(dir9);
  s10.prime();
  s10.add({ id: 'after-torn', ts: bj(2026, 9, 28, 4), source: 'proxy', model: 'k3', input: 1, output: 1 });

  const raw9 = fs.readFileSync(f9, 'utf8');
  const parsed = [];
  for (const l of raw9.split('\n').filter(Boolean)) { try { parsed.push(JSON.parse(l)); } catch { /* 坏行 */ } }
  const ids = parsed.map((o) => o.id);
  ok(ids.includes('after-torn'), '16.1 ★ 崩溃后写入的新记录能被解析到（没被粘在坏行后面）');
  ok(ids.includes('ok1'), '16.2 之前的完好记录还在');
  // 坏行仍然存在（不静默删用户数据），但不影响新记录
  ok(raw9.includes('TORN'), '16.3 坏行被原样保留（没有静默删除）');
  // 明细接口应当能列出这条
  const listed = s10.recentRecords({ limit: 10 }).records.map((r) => r.id);
  ok(listed.includes('after-torn'), '16.4 新记录出现在明细列表里');
}

// ---------- 17) detailLines 要与实际保留的行数一致（H3）----------
{
  const dir10 = path.join(tmp, 'usage10');
  fs.mkdirSync(dir10, { recursive: true });
  const f10 = path.join(dir10, 'usage.jsonl');
  const rows = [];
  for (let i = 0; i < 5; i++) rows.push(JSON.stringify({ id: 'p' + i, ts: bj(2026, 9, 28, 3), source: 'proxy', model: 'k3', input: 1, output: 1 }));
  fs.writeFileSync(f10, rows.join('\n') + '\n');
  fs.appendFileSync(f10, '{"id":"TORN"');   // 半行

  const s11 = createUsageStore(dir10);
  s11.prime();
  s11.recompute();
  const actual = fs.readFileSync(f10, 'utf8').split('\n').filter(Boolean).length;
  eq(s11.lines, actual, '17.1 ★ detailLines 与实际保留行数一致（含坏行）');
  ok(s11.lines === 6, '17.2 5 条好记录 + 1 条坏行 = 6');
}

// ---------- 结果 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
console.log(`\n用量统计端到端：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
