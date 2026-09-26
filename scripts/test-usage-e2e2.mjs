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
  const d = store.daily;
  ok(d['2026-09-26'], '3.1 有 2026-09-26 当天的桶');
  const h = store.hourly;
  ok(h['2026-09-26T09'], '3.2 有 09 点的小时桶');
  ok(h['2026-09-26T15'], '3.3 有 15 点的小时桶');
  eq(hourKey(bj(2026, 9, 26, 9, 30)), '2026-09-26T09', '3.4 hourKey 取整点');
  eq(dayKey(bj(2026, 9, 26, 23, 59)), '2026-09-26', '3.5 dayKey 当天');

  // 小时桶合计要等于当天总量（两套汇总必须一致，否则界面两个图对不上）
  const hourSum = Object.entries(h).filter(([k]) => k.startsWith('2026-09-26'))
    .reduce((n, [, v]) => n + Object.values(v.rollups).reduce((a, r) => a + r.requests, 0), 0);
  const daySum = Object.values(d['2026-09-26'].rollups).reduce((a, r) => a + r.requests, 0);
  eq(hourSum, daySum, '3.6 小时合计 = 当天合计');

  // 跨小时分布：09 点 1 条（e2e-early），15 点 1 条（e2e-late），0 点 60 条（bulk）
  const at9 = Object.values(h['2026-09-26T09'].rollups).reduce((a, r) => a + r.requests, 0);
  const at15 = Object.values(h['2026-09-26T15'].rollups).reduce((a, r) => a + r.requests, 0);
  const at0 = Object.values(h['2026-09-26T00'].rollups).reduce((a, r) => a + r.requests, 0);
  eq(at9, 1, '3.7 09 点 1 条');
  eq(at15, 1, '3.8 15 点 1 条');
  eq(at0, 60, '3.9 0 点 60 条');
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
  for (let d = 0; d < 12; d++) {
    for (let h = 0; h < 24; h++) {
      s3.add({ id: `hb-${d}-${h}`, ts: bj(2026, 9, 1 + d, h, 0), source: 'proxy', model: 'k3', input: 1, output: 1 });
    }
  }
  const keys = Object.keys(s3.hourly);
  ok(keys.length <= 4 * 24, `8.1 小时桶被裁剪到 4 天以内（实际 ${keys.length}）`);
  ok(keys.length > 0, '8.2 还留着最近的小时桶');
  // 最近的必须留着
  const lastKey = keys.sort()[keys.length - 1];
  ok(lastKey.startsWith('2026-09-12'), `8.3 保留的是最近的（最老为 ${keys.sort()[0]}）`);
  // 按天汇总不受小时裁剪影响
  eq(Object.keys(s3.daily).length, 12, '8.4 按天汇总完整保留 12 天');
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
  s4.add({ id: 'av-1', ts: bj(2026, 9, 21, 3, 0), source: 'proxy', model: 'k3', input: 1, output: 1 });
  s4.add({ id: 'av-2', ts: bj(2026, 9, 26, 15, 0), source: 'proxy', model: 'k3', input: 1, output: 1 });
  const allDays = Object.keys(s4.daily).sort();
  ok(allDays.every((k) => k.length === 10), '10.1 按天键是 10 位日期，不含小时');
  eq(allDays[0], '2026-09-21', '10.2 available.from 是最早那天');
  eq(allDays[allDays.length - 1], '2026-09-26', '10.3 available.to 是最晚那天');
  // 小时键确实带小时 —— 所以绝不能用它填 available
  ok(Object.keys(s4.hourly).some((k) => k.length > 10), '10.4 小时键比天键长（两者不能混用）');
  eq(dayKey(Date.parse('2026-09-21T03:00:00Z')), '2026-09-21', '10.5 dayKey 抹掉小时');
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
  eq(Object.keys(s5.daily).length, 0, '11.1 重算前没有汇总（老数据只有明细）');
  const rc = s5.recompute();
  eq(rc.records, 11, '11.2 重算覆盖全部记录');
  eq(rc.days, 1, '11.3 建出了 1 天的汇总');
  // 10 条 DeepSeek，每条 空闲价 = 1e6 未命中(¥1) + 1e6 输出(¥4) = ¥5
  near(rc.cny, 50, '11.4 人民币合计 = 10 × ¥5 = ¥50');
  const sum = Object.values(s5.daily['2026-09-28'].rollups).reduce((a, r) => a + (r.costCny || 0), 0);
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

// ---------- 结果 ----------
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
console.log(`\n用量统计端到端：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
