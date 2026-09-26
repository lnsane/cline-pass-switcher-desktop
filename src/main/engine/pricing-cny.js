// DeepSeek 官方价目表（人民币）与峰谷时段判定
//
// 为什么单独一个文件：这套价格是**供应商官方公开价**，单位是人民币，还有峰谷时段，
// 和 models.dev 那张「美元/百万 token、单价固定」的表完全是两套东西。混在一起
// 会让人分不清某个数字到底是账单还是估算、是美元还是人民币 —— 那是会误导人的。
//
// 价格来源：DeepSeek 官方定价页（中文版为准）
//   https://api-docs.deepseek.com/zh-cn/quick_start/pricing/
//   单位：元 / 百万 token
//
// 峰谷规则（官方原文）：
//   北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰时段；
//   其余时段，包括周末及中国法定节假日全天均为空闲时段。
//   空闲时段价格为高峰时段价格的一半。
//
// 节假日来源：国务院办公厅关于 2026 年部分节假日安排的通知（国办发明电〔2025〕7 号）
//   https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
//
// 两个必须说清楚的判定细节（都是「按字面读」的结果，不是猜测）：
//
// 1. **调休补班日按周末算（空闲）**。官方那句「周一至周五……为高峰」限定的是周一至周五，
//    而调休补班日全都落在周六/周日；另一句「包括周末……全天均为空闲」又把周末整个划进空闲。
//    所以 2026-02-14（周六补班）按空闲计。官方页面没有就调休日单独表态，这是字面推论 ——
//    写在这里是为了让它可被审计、可被推翻，而不是藏在代码里当默认值。
// 2. **区间左闭右开**：12:00 整、18:00 整算空闲。官方只给了「9:00 - 12:00」这种写法，
//    边界语义没定义，取半开区间是最不意外的解释。

// 北京时间固定 +8，且中国不实行夏令时 —— 所以「北京墙上时间」可以直接用
// 时间戳加偏移后取 UTC 字段得到。**刻意不用本地时区**：CI 跑在 UTC，
// 若用 getHours() 之类的本地方法，同一份数据在不同机器上会算出不同的峰谷。
const BJ_OFFSET_MS = 8 * 3600 * 1000;

export const CNY_SYMBOL = '¥';

// ---------- 官方价目表（元 / 百万 token）----------
// cacheHit = 缓存命中输入，cacheMiss = 缓存未命中输入，output = 输出。
// pro 的 cacheHit 官方给了 0.15/0.30（是 flash 的 7.5 倍左右），照抄，不做任何「取整好看」。
export const DEEPSEEK_CNY = {
  currency: 'CNY',
  symbol: CNY_SYMBOL,
  unit: 1e6,
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  models: {
    'deepseek-flash': {
      n: 'DeepSeek-V4.1-Flash',
      cacheHit: { offpeak: 0.02, peak: 0.04 },
      cacheMiss: { offpeak: 1, peak: 2 },
      output: { offpeak: 4, peak: 8 },
    },
    'deepseek-v4-pro': {
      n: 'DeepSeek-V4-Pro-0813',
      cacheHit: { offpeak: 0.15, peak: 0.30 },
      cacheMiss: { offpeak: 4.5, peak: 9.0 },
      output: { offpeak: 13.5, peak: 27.0 },
    },
  },
  // 线路上的名字 → 价目表键。
  //
  // 官方说明：旧模型名 deepseek-v4-flash 与 deepseek-v4-flash-vision-exp 仍可调用，
  // 但那两个模型已下线，请求实际由 DeepSeek-V4.1-Flash 提供服务，**并按 Flash 价格计费**。
  // 所以旧名要一起映射到 flash —— 否则这些请求会被算成「没有人民币价」而落到美元那栏，
  // 明明是同一笔钱却分了两处显示。
  aliases: {
    'deepseek-flash': 'deepseek-flash',
    'deepseek-v4.1-flash': 'deepseek-flash',
    'deepseek-v4-flash': 'deepseek-flash',
    'deepseek-v4-flash-0731': 'deepseek-flash',
    'deepseek-v4-flash-vision-exp': 'deepseek-flash',
    'deepseek-v4-pro': 'deepseek-v4-pro',
    'deepseek-v4-pro-0813': 'deepseek-v4-pro',
  },
  // 高峰时段（北京时间，左闭右开）
  peakWindows: [[9, 12], [14, 18]],
  // 法定节假日（含调休连休的整段）。按年分组，便于逐年更新与测试。
  holidays: {
    // 国办发明电〔2025〕7号
    2026: [
      ['2026-01-01', '2026-01-03'], // 元旦
      ['2026-02-15', '2026-02-23'], // 春节（9 天，最长的一段）
      ['2026-04-04', '2026-04-06'], // 清明节
      ['2026-05-01', '2026-05-05'], // 劳动节
      ['2026-06-19', '2026-06-21'], // 端午节
      ['2026-09-25', '2026-09-27'], // 中秋节
      ['2026-10-01', '2026-10-07'], // 国庆节
    ],
  },
};

export const HOLIDAY_YEARS = Object.keys(DEEPSEEK_CNY.holidays).map(Number).sort();

// ---------- 北京墙上时间 ----------
// 返回北京时间的年/月/日/时/分与星期，全部由 UTC 字段计算，与运行机器的时区无关。
export function beijingParts(ts) {
  const d = new Date(Number(ts) + BJ_OFFSET_MS);
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return {
    y, m, d: day,
    dow: d.getUTCDay(),   // 0=周日
    h: d.getUTCHours(),
    min: d.getUTCMinutes(),
    date: `${y}-${p(m)}-${p(day)}`,
    hh: `${y}-${p(m)}-${p(day)}T${p(d.getUTCHours())}`,
  };
}

// 把 ['YYYY-MM-DD','YYYY-MM-DD'] 的闭区间展开成日期集合。
// 展开而不是手写每一天：区间直接照抄官方通知，少一次人工转录就少一处出错机会。
const HOLIDAY_SETS = (() => {
  const out = {};
  for (const [year, ranges] of Object.entries(DEEPSEEK_CNY.holidays)) {
    const set = new Set();
    for (const [from, to] of ranges) {
      // 用 UTC 迭代，避免本地时区把日期推偏一天
      let cur = Date.parse(from + 'T00:00:00Z');
      const end = Date.parse(to + 'T00:00:00Z');
      if (!Number.isFinite(cur) || !Number.isFinite(end) || end < cur) continue;
      for (; cur <= end; cur += 86400e3) {
        set.add(new Date(cur).toISOString().slice(0, 10));
      }
    }
    out[Number(year)] = set;
  }
  return out;
})();

export function holidayDates(year) {
  const s = HOLIDAY_SETS[Number(year)];
  return s ? [...s].sort() : [];
}

// 该北京日期是否落在法定节假日里。没有该年份数据时返回 false ——
// 「不知道」不等于「是节假日」，宁可算出高峰价（偏高）也不要凭空把价格打对折。
export function isChinaHoliday(dateStr) {
  const y = Number(String(dateStr).slice(0, 4));
  const set = HOLIDAY_SETS[y];
  return !!set && set.has(dateStr);
}

// 是否高峰时段。周末与法定节假日全天算空闲。
export function isPeak(ts) {
  const p = beijingParts(ts);
  if (p.dow === 0 || p.dow === 6) return false;    // 周末（含调休补班的周末，见文件头说明）
  if (isChinaHoliday(p.date)) return false;        // 法定节假日
  for (const [a, b] of DEEPSEEK_CNY.peakWindows) {
    if (p.h >= a && p.h < b) return true;          // 左闭右开
  }
  return false;
}

// ---------- 模型名解析 ----------
// 去掉 provider 前缀（cline-pass/、deepseek/）与日期后缀，再查别名表。
// 返回价目表键，认不出返回 null —— 由调用方决定「不计人民币价」，
// 而不是拿 0 或拿别家的价格顶上冒充。
export function resolveDeepseekModel(...candidates) {
  for (const raw of candidates) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key) continue;
    const tries = [key];
    const slash = key.lastIndexOf('/');
    if (slash >= 0) tries.push(key.slice(slash + 1));
    for (const t of tries.slice()) {
      const stripped = t.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
      if (stripped !== t) tries.push(stripped);
    }
    for (const t of tries) {
      if (DEEPSEEK_CNY.aliases[t]) return DEEPSEEK_CNY.aliases[t];
    }
  }
  return null;
}

// 这个模型名是否有官方人民币价。
export const hasDeepseekCnyPrice = (...candidates) => resolveDeepseekModel(...candidates) !== null;

// ---------- 计费 ----------
// token 口径（Anthropic 口径，与 usage.js 一致）：
//   input        缓存未命中输入
//   cacheRead    缓存命中输入
//   cacheCreation 缓存写入 —— DeepSeek 价目表里没有「缓存写入」这一档，并入未命中输入。
//                 这是**偏保守**的处理（按贵的算），不会少算钱。
//   output       输出
//
// 返回 null 表示这个模型没有官方人民币价（不是 0 元）。
export function deepseekCostCny(model, tok, ts) {
  const t = tok || {};
  const key = resolveDeepseekModel(t.pricingModel, t.canonical, model);
  if (!key) return null;
  const row = DEEPSEEK_CNY.models[key];
  if (!row) return null;
  const peak = isPeak(ts);
  const band = peak ? 'peak' : 'offpeak';
  const M = DEEPSEEK_CNY.unit;
  const miss = (Number(t.input) || 0) + (Number(t.cacheCreation) || 0);
  const hit = Number(t.cacheRead) || 0;
  const out = Number(t.output) || 0;
  const cost =
    (miss / M) * row.cacheMiss[band] +
    (hit / M) * row.cacheHit[band] +
    (out / M) * row.output[band];
  return {
    cost,
    currency: 'CNY',
    peak,
    band,
    pricingKey: key,
    modelName: row.n,
    // 把这次用的单价一并带出来：界面上「为什么这笔是 2 元不是 1 元」要能答得上来
    rates: { cacheMiss: row.cacheMiss[band], cacheHit: row.cacheHit[band], output: row.output[band] },
    tokens: { cacheMiss: miss, cacheRead: hit, output: out },
  };
}

// 供界面与测试用的一份「现在处于什么时段」的说明。
//
// 同时返回 `code` 和一个中文 `reason`：**界面要用 code 自己查字典**，
// 不能直接把 reason 拼进句子里 —— 那样切英文时会留下一段中文
// （译文是在渲染层按整句查表做的，拼进去的中文没人翻）。
// reason 保留是给日志和命令行看的，不影响界面。
export function describeBand(ts) {
  const p = beijingParts(ts);
  const peak = isPeak(ts);
  const holiday = isChinaHoliday(p.date);
  const weekend = p.dow === 0 || p.dow === 6;
  const code = holiday ? 'holiday' : weekend ? 'weekend' : peak ? 'peak' : 'offpeak';
  const reason = holiday ? '法定节假日（全天空闲）'
    : weekend ? '周末（全天空闲）'
      : peak ? '工作日高峰时段' : '工作日空闲时段';
  return { peak, holiday, weekend, code, date: p.date, hour: p.h, reason };
}
