// DeepSeek 人民币价目表与峰谷时段判定的离线单元测试
//
// 重点验证三件事：
//   1. 价格数字与官方页一致（含峰谷两档）
//   2. 峰谷判定**与运行机器的时区无关** —— 这是最容易出错、也最难在本地发现的地方
//      （本机是 UTC+8，看起来永远对；CI 在 UTC，用本地时间就会错）
//   3. 边界与节假日按文件头写明的语义走
import {
  DEEPSEEK_CNY, resolveDeepseekModel, hasDeepseekCnyPrice, deepseekCostCny,
  isPeak, isChinaHoliday, holidayDates, beijingParts, describeBand, HOLIDAY_YEARS,
} from '../src/main/engine/pricing-cny.js';

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

// 构造一个北京时间的时刻（避免测试里手写 UTC 换算）
function bj(y, m, d, h, min = 0) {
  return Date.UTC(y, m - 1, d, h, min) - 8 * 3600 * 1000;
}

// ---------- 1) 官方价格数字 ----------
{
  const f = DEEPSEEK_CNY.models['deepseek-flash'];
  eq(f.cacheHit.offpeak, 0.02, '1.1 flash 缓存命中 空闲 0.02');
  eq(f.cacheHit.peak, 0.04, '1.2 flash 缓存命中 高峰 0.04');
  eq(f.cacheMiss.offpeak, 1, '1.3 flash 未命中 空闲 1');
  eq(f.cacheMiss.peak, 2, '1.4 flash 未命中 高峰 2');
  eq(f.output.offpeak, 4, '1.5 flash 输出 空闲 4');
  eq(f.output.peak, 8, '1.6 flash 输出 高峰 8');

  const p = DEEPSEEK_CNY.models['deepseek-v4-pro'];
  eq(p.cacheHit.offpeak, 0.15, '1.7 pro 缓存命中 空闲 0.15');
  eq(p.cacheHit.peak, 0.30, '1.8 pro 缓存命中 高峰 0.30');
  eq(p.cacheMiss.offpeak, 4.5, '1.9 pro 未命中 空闲 4.5');
  eq(p.cacheMiss.peak, 9.0, '1.10 pro 未命中 高峰 9.0');
  eq(p.output.offpeak, 13.5, '1.11 pro 输出 空闲 13.5');
  eq(p.output.peak, 27.0, '1.12 pro 输出 高峰 27.0');

  // 官方原文：空闲价是高峰价的一半。这条不变量能挡住「改了一个忘了改另一个」。
  for (const [name, row] of Object.entries(DEEPSEEK_CNY.models)) {
    near(row.cacheHit.offpeak * 2, row.cacheHit.peak, `1.13 ${name} 缓存命中 空闲=高峰/2`);
    near(row.cacheMiss.offpeak * 2, row.cacheMiss.peak, `1.14 ${name} 未命中 空闲=高峰/2`);
    near(row.output.offpeak * 2, row.output.peak, `1.15 ${name} 输出 空闲=高峰/2`);
  }
  eq(DEEPSEEK_CNY.currency, 'CNY', '1.16 币种是人民币');
  eq(DEEPSEEK_CNY.unit, 1e6, '1.17 单位是百万 token');
}

// ---------- 2) 模型名解析 ----------
{
  eq(resolveDeepseekModel('cline-pass/deepseek-v4.1-flash'), 'deepseek-flash', '2.1 线上名 → flash');
  eq(resolveDeepseekModel('deepseek/deepseek-v4.1-flash'), 'deepseek-flash', '2.2 规范名 → flash');
  eq(resolveDeepseekModel('deepseek-flash'), 'deepseek-flash', '2.3 官方名 → flash');
  eq(resolveDeepseekModel('deepseek-v4-pro'), 'deepseek-v4-pro', '2.4 pro');
  eq(resolveDeepseekModel('cline-pass/deepseek-v4-pro'), 'deepseek-v4-pro', '2.5 带前缀 pro');
  // 旧名按官方说明走 Flash 价（模型已下线，请求由 V4.1-Flash 服务）
  eq(resolveDeepseekModel('deepseek-v4-flash'), 'deepseek-flash', '2.6 旧名 v4-flash → flash 价');
  eq(resolveDeepseekModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash', '2.7 旧视觉名 → flash 价');
  eq(resolveDeepseekModel('deepseek-v4-flash-0731'), 'deepseek-flash', '2.8 带日期旧名 → flash 价');
  // 不是 DeepSeek 的一律认不出
  eq(resolveDeepseekModel('k3'), null, '2.9 k3 没有人民币价');
  eq(resolveDeepseekModel('cline-pass/glm-5.3-flash'), null, '2.10 glm 没有人民币价');
  eq(resolveDeepseekModel(''), null, '2.11 空串');
  eq(resolveDeepseekModel(null, undefined), null, '2.12 null/undefined');
  eq(hasDeepseekCnyPrice('cline-pass/deepseek-v4.1-flash'), true, '2.13 has 判断 true');
  eq(hasDeepseekCnyPrice('k3'), false, '2.14 has 判断 false');
}

// ---------- 3) 峰谷判定（核心：与机器时区无关）----------
{
  // 2026-09-28 是周一
  ok(isPeak(bj(2026, 9, 28, 9, 0)), '3.1 周一 09:00 高峰（左闭）');
  ok(isPeak(bj(2026, 9, 28, 11, 59)), '3.2 周一 11:59 高峰');
  ok(!isPeak(bj(2026, 9, 28, 12, 0)), '3.3 周一 12:00 空闲（右开）');
  ok(!isPeak(bj(2026, 9, 28, 13, 59)), '3.4 周一 13:59 空闲（午休）');
  ok(isPeak(bj(2026, 9, 28, 14, 0)), '3.5 周一 14:00 高峰');
  ok(isPeak(bj(2026, 9, 28, 17, 59)), '3.6 周一 17:59 高峰');
  ok(!isPeak(bj(2026, 9, 28, 18, 0)), '3.7 周一 18:00 空闲（右开）');
  ok(!isPeak(bj(2026, 9, 28, 8, 59)), '3.8 周一 08:59 空闲');
  ok(!isPeak(bj(2026, 9, 28, 23, 0)), '3.9 周一 23:00 空闲');
  ok(!isPeak(bj(2026, 9, 28, 3, 0)), '3.10 周一凌晨空闲');

  // 周末全天空闲（2026-09-12 周六、09-13 周日 —— 刻意避开 09-25~27 的中秋假期，
  // 否则测到的是「节假日」那条分支，`reason` 也就不是「周末」了）
  ok(!isPeak(bj(2026, 9, 12, 10, 0)), '3.11 周六 10:00 空闲');
  ok(!isPeak(bj(2026, 9, 13, 15, 0)), '3.12 周日 15:00 空闲');
  ok(!isPeak(bj(2026, 9, 12, 9, 30)), '3.13 周六高峰钟点内也空闲');

  // 周五 vs 周六跨天
  ok(isPeak(bj(2026, 9, 25 - 0, 10, 0)) === false, '3.14 09-25 是中秋节假日 → 空闲');
  ok(isPeak(bj(2026, 10, 9, 10, 0)), '3.15 10-09 周五（节后）高峰');
  ok(!isPeak(bj(2026, 10, 10, 10, 0)), '3.16 10-10 周六补班 → 按周末算空闲（见文件头说明）');
}

// ---------- 4) 节假日 ----------
{
  eq(holidayDates(2026).length, 3 + 9 + 3 + 5 + 3 + 3 + 7, '4.1 2026 节假日共 33 天');
  ok(isChinaHoliday('2026-02-17'), '4.2 春节内');
  ok(isChinaHoliday('2026-02-15'), '4.3 春节首日');
  ok(isChinaHoliday('2026-02-23'), '4.4 春节末日');
  ok(!isChinaHoliday('2026-02-24'), '4.5 春节次日不是节假日');
  ok(isChinaHoliday('2026-10-01'), '4.6 国庆首日');
  ok(isChinaHoliday('2026-10-07'), '4.7 国庆末日');
  ok(!isChinaHoliday('2026-10-08'), '4.8 国庆次日不是节假日');
  ok(isChinaHoliday('2026-09-25'), '4.9 中秋首日');
  ok(isChinaHoliday('2026-01-01'), '4.10 元旦');
  ok(isChinaHoliday('2026-01-03'), '4.11 元旦末日');
  ok(!isChinaHoliday('2026-01-04'), '4.12 01-04 是补班日，不是节假日');
  ok(!isChinaHoliday('2026-03-15'), '4.13 平常日');
  // 没有数据的年份：「不知道」不能当成「是节假日」
  eq(isChinaHoliday('2027-01-01'), false, '4.14 未收录年份返回 false');
  eq(holidayDates(2027).length, 0, '4.15 未收录年份无数据');
  ok(HOLIDAY_YEARS.includes(2026), '4.16 HOLIDAY_YEARS 含 2026');

  // 假期覆盖：三天以上连休的每一段都要真的整天覆盖
  const days = holidayDates(2026);
  ok(days.includes('2026-05-05') && days.includes('2026-05-01'), '4.17 劳动节整段');
  ok(days.includes('2026-06-21') && days.includes('2026-06-19'), '4.18 端午整段');
  ok(days.includes('2026-04-06') && days.includes('2026-04-04'), '4.19 清明整段');
  // 连续性：02-15..02-23 九天一天不漏
  let allThere = true;
  for (let i = 0; i < 9; i++) {
    const t = Date.parse('2026-02-15T00:00:00Z') + i * 86400e3;
    if (!isChinaHoliday(new Date(t).toISOString().slice(0, 10))) allThere = false;
  }
  ok(allThere, '4.20 春节 9 天连续无缺口');
}

// ---------- 5) 北京时间换算 ----------
{
  const p = beijingParts(bj(2026, 9, 28, 9, 30));
  eq(p.date, '2026-09-28', '5.1 北京日期');
  eq(p.h, 9, '5.2 北京小时');
  eq(p.min, 30, '5.3 北京分钟');
  eq(p.dow, 1, '5.4 星期一');
  // 跨日：北京 00:30 对应 UTC 前一天 16:30 —— 用本地时区算就会错到这里
  const q = beijingParts(bj(2026, 9, 28, 0, 30));
  eq(q.date, '2026-09-28', '5.5 北京凌晨仍算当天');
  eq(q.h, 0, '5.6 北京小时为 0');
  eq(q.dow, 1, '5.7 仍是星期一');
}

// ---------- 6) 计费 ----------
{
  const ts_peak = bj(2026, 9, 28, 10, 0);      // 周一高峰
  const ts_off = bj(2026, 9, 26, 10, 0);       // 周六空闲

  // flash：未命中 1M + 命中 1M + 输出 1M
  const tok = { input: 1e6, cacheRead: 1e6, cacheCreation: 0, output: 1e6 };
  const peak = deepseekCostCny('cline-pass/deepseek-v4.1-flash', tok, ts_peak);
  near(peak.cost, 2 + 0.04 + 8, '6.1 flash 高峰价 = 未命中2 + 命中0.04 + 输出8');
  eq(peak.peak, true, '6.2 标记为高峰');
  eq(peak.currency, 'CNY', '6.3 币种人民币');
  eq(peak.pricingKey, 'deepseek-flash', '6.4 命中价目表键');

  const off = deepseekCostCny('cline-pass/deepseek-v4.1-flash', tok, ts_off);
  near(off.cost, 1 + 0.02 + 4, '6.5 flash 空闲价 = 未命中1 + 命中0.02 + 输出4');
  eq(off.peak, false, '6.6 标记为空闲');
  // 官方：空闲价正好是高峰价的一半
  near(off.cost * 2, peak.cost, '6.7 空闲 = 高峰 / 2');

  // pro
  const pro = deepseekCostCny('deepseek-v4-pro', tok, ts_peak);
  near(pro.cost, 9 + 0.30 + 27, '6.8 pro 高峰价');

  // 缓存写入并入未命中（偏保守，按贵的算）
  const withCreation = deepseekCostCny('deepseek-flash', { input: 0, cacheRead: 0, cacheCreation: 2e6, output: 0 }, ts_off);
  near(withCreation.cost, 2, '6.9 缓存写入按未命中价计（2M × 1 元）');
  eq(withCreation.tokens.cacheMiss, 2e6, '6.10 缓存写入计入未命中 token');

  // 小额：真实一笔的量级，验证不丢精度
  const small = deepseekCostCny('cline-pass/deepseek-v4.1-flash',
    { input: 260, cacheRead: 351488, cacheCreation: 0, output: 926 }, bj(2026, 9, 28, 3, 0));
  near(small.cost, (260 / 1e6) * 1 + (351488 / 1e6) * 0.02 + (926 / 1e6) * 4, '6.11 小额空闲价精确');

  // 非 DeepSeek 返回 null，而不是 0
  eq(deepseekCostCny('k3', tok, ts_peak), null, '6.12 k3 没有人民币价（null 而非 0）');
  eq(deepseekCostCny('cline-pass/glm-5.3-flash', tok, ts_peak), null, '6.13 glm 没有人民币价');

  // 缺字段当 0 处理，不炸
  const empty = deepseekCostCny('deepseek-flash', {}, ts_off);
  near(empty.cost, 0, '6.14 空 token 记 0 元');
  const nul = deepseekCostCny('deepseek-flash', null, ts_off);
  near(nul.cost, 0, '6.15 null token 记 0 元');
}

// ---------- 7) 时段说明 ----------
{
  eq(describeBand(bj(2026, 9, 28, 10, 0)).reason, '工作日高峰时段', '7.1 高峰说明');
  eq(describeBand(bj(2026, 9, 28, 3, 0)).reason, '工作日空闲时段', '7.2 空闲说明');
  eq(describeBand(bj(2026, 9, 12, 10, 0)).reason, '周末（全天空闲）', '7.3 周末说明');
  eq(describeBand(bj(2026, 10, 1, 10, 0)).reason, '法定节假日（全天空闲）', '7.4 节假日说明');
  eq(describeBand(bj(2026, 10, 1, 10, 0)).holiday, true, '7.5 节假日标记');
  // code 是给界面查字典用的稳定标识 —— 界面不能直接显示 reason（那是中文，切英文会漏）
  eq(describeBand(bj(2026, 9, 28, 10, 0)).code, 'peak', '7.6 高峰 code');
  eq(describeBand(bj(2026, 9, 28, 3, 0)).code, 'offpeak', '7.7 空闲 code');
  eq(describeBand(bj(2026, 9, 12, 10, 0)).code, 'weekend', '7.8 周末 code');
  eq(describeBand(bj(2026, 10, 1, 10, 0)).code, 'holiday', '7.9 节假日 code');
}

// ---------- 8) 时区无关性 ----------
// 这一节是整个文件最重要的：把 TZ 改成纽约/UTC，同一时刻必须得出同一结论。
// 用子进程各跑一次，因为 process.env.TZ 在 Node 里改了对已缓存的时区不一定生效。
{
  const { execFileSync } = await import('node:child_process');
  const script = `
    import { isPeak, beijingParts } from '${new URL('../src/main/engine/pricing-cny.js', import.meta.url).href}';
    const ts = Date.UTC(2026, 8, 28, 2, 0) - 0; // 北京 10:00 周一
    const p = beijingParts(ts);
    console.log(JSON.stringify({ peak: isPeak(ts), date: p.date, hour: p.h }));
  `;
  const results = [];
  for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai', 'Pacific/Kiritimati']) {
    try {
      const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        env: { ...process.env, TZ: tz }, encoding: 'utf8', timeout: 20000,
      });
      results.push({ tz, ...JSON.parse(out.trim()) });
    } catch (e) {
      results.push({ tz, error: e.message.slice(0, 120) });
    }
  }
  const good = results.filter((r) => !r.error);
  eq(good.length, 4, '8.1 四个时区都跑起来了');
  ok(good.every((r) => r.peak === true), '8.2 各时区都判定为高峰');
  ok(good.every((r) => r.date === '2026-09-28'), '8.3 各时区得出同一北京日期');
  ok(good.every((r) => r.hour === 10), '8.4 各时区得出同一北京小时');
  const uniq = new Set(good.map((r) => r.peak + '|' + r.date + '|' + r.hour));
  eq(uniq.size, 1, '8.5 各时区结论完全一致');
}

// ---------- 结果 ----------
console.log(`\nDeepSeek 人民币计价：通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('\n失败项：');
  for (const f of failures) console.log('  ✗ ' + f);
  process.exit(1);
}
console.log('✓ 全部通过');
