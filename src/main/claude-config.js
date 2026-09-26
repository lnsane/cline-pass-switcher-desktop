// 把本机代理写进 Claude Code 的 ~/.claude/settings.json
//
// 为什么单独一个模块：这个功能会改用户的全局配置，风险集中在「合并」与「备份」两处逻辑上。
// 纯函数部分（buildEnv / mergeSettings）与文件操作分开，前者可以脱离文件系统单独测。
//
// 设计约束：
// - 只动我们负责的 env 键，其余顶层键与 env 键一律原样保留（绝不能整体覆盖用户配置）
// - 已有的 settings.json 不是合法 JSON 时**拒绝写入**，不做任何猜测性修复
// - 写入前一定备份；写入用「临时文件 + 改名」避免写一半被打断
// - 支持撤销：从最近一次备份还原
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 我们负责的 env 键。*_MODEL_NAME 与 *_MODEL 成对写：Claude Code 用 MODEL 认模型、
// 用 NAME 显示；两边写同一个真模型名，既避免它按未知模型处理，也不留下旧值造成不一致。
export function managedKeys(model) {
  return {
    ANTHROPIC_BASE_URL: undefined, // 由调用方填
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL: model,
    ANTHROPIC_DEFAULT_FABLE_MODEL_NAME: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

// settings.json 的位置。CLAUDE_SETTINGS_PATH 用于测试与多环境，不设时就是 Claude Code 的默认位置。
export function settingsPath() {
  return process.env.CLAUDE_SETTINGS_PATH || path.join(os.homedir(), '.claude', 'settings.json');
}

// 构造要写入的 env。baseUrl 用根地址（Anthropic 的惯例）：客户端自己拼 /v1/messages。
// 本机代理同时收 /messages 与 /v1/messages，所以带不带 /v1 都能用。
export function buildEnv({ baseUrl, token, model }) {
  const env = managedKeys(model);
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = token;
  return env;
}

// 纯函数：把 env 合并进已有配置对象，返回新对象与逐键的变更分类
export function mergeSettings(existing, env) {
  const base = existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {};
  const out = { ...base };
  const prevEnv = base.env && typeof base.env === 'object' && !Array.isArray(base.env) ? base.env : {};
  out.env = { ...prevEnv, ...env };

  const added = [];
  const changed = [];
  const same = [];
  for (const [k, v] of Object.entries(env)) {
    if (!(k in prevEnv)) added.push(k);
    else if (prevEnv[k] !== v) changed.push(k);
    else same.push(k);
  }
  return { settings: out, added, changed, same, prevEnv };
}

// 读取既有配置；解析失败时明确回报，交给上层拒绝写入
export function readSettings(file = settingsPath()) {
  if (!fs.existsSync(file)) return { exists: false, path: file, json: null, text: '', error: null };
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { exists: true, path: file, json: null, text: '', error: '读取失败：' + e.message };
  }
  if (!text.trim()) return { exists: true, path: file, json: null, text, error: '文件为空' };
  try {
    return { exists: true, path: file, json: JSON.parse(text), text, error: null };
  } catch (e) {
    return { exists: true, path: file, json: null, text, error: '不是合法 JSON：' + e.message };
  }
}

// 预览（不落盘）：给界面显示"将要改哪些键"
export function preview(env, file = settingsPath()) {
  const cur = readSettings(file);
  if (cur.error) return { ok: false, path: cur.path, exists: cur.exists, error: cur.error };
  const m = mergeSettings(cur.json, env);
  return {
    ok: true,
    path: cur.path,
    exists: cur.exists,
    added: m.added,
    changed: m.changed,
    same: m.same,
    // 会把已有的哪些值改掉（供界面展示 before → after）
    diffs: [...m.added, ...m.changed].map((k) => ({ key: k, from: m.prevEnv[k], to: env[k] })),
    keptTopLevel: Object.keys(cur.json || {}).filter((k) => k !== 'env'),
  };
}

// 备份文件名里的时间戳。
// 注意两个坑：① 只到秒的话，「写入后立刻还原」会让安全备份与源备份撞名，安全备份会把
// 要还原的那份覆盖掉 —— 还原就静默失败了，而且原配置也找不回来。所以带上毫秒。
// ② 不能结尾带点：Windows 会剥掉文件名尾部的点，剥完更容易撞名。
function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(d.getMilliseconds(), 3)}`;
}

// 即便同一毫秒也不覆盖已有备份
function uniquePath(base) {
  if (!fs.existsSync(base)) return base;
  for (let i = 1; i < 1000; i++) {
    const c = base + '-' + i;
    if (!fs.existsSync(c)) return c;
  }
  return base + '-' + Date.now();
}

// 备份分两类，后缀必须区分开：
//   .bak-         写入前的备份 —— 「还原」认的就是这一类（还原的目标）
//   .pre-restore- 还原前的安全备份 —— 只是防手滑，**不能被当成还原目标**
// 混在一起的话，连点两次「还原」会先还原到旧状态、再把安全备份（新状态）当成目标还原回去，
// 在两种状态之间来回跳。分开之后「还原」是幂等的：一直指向写入前的那一份。
const BAK = '.bak-';
const PRE_RESTORE = '.pre-restore-';

// 备份当前配置，返回备份路径；文件不存在时返回 null
function backupFile(file, suffix) {
  if (!fs.existsSync(file)) return null;
  const dest = uniquePath(file + suffix + stamp());
  fs.copyFileSync(file, dest);
  return dest;
}

function backupsWith(file, suffix) {
  const dir = path.dirname(file);
  const stem = path.basename(file) + suffix;
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(stem))
      .sort()
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

function prunePrefix(file, suffix, keep) {
  const names = backupsWith(file, suffix);
  for (const n of names.slice(0, Math.max(0, names.length - keep))) {
    try {
      fs.unlinkSync(n);
    } catch {
      /* 清理失败不影响主流程 */
    }
  }
}

function pruneBackups(file, keep = 10) {
  prunePrefix(file, BAK, keep);
  prunePrefix(file, PRE_RESTORE, keep);
}

// 可供「还原」的目标：只有写入前的备份
export function listBackups(file = settingsPath()) {
  return backupsWith(file, BAK);
}

// 写入：备份 → 临时文件 → 改名。任何一步失败都不留下半个文件。
export function writeSettings(env, file = settingsPath()) {
  const cur = readSettings(file);
  if (cur.error) return { ok: false, error: cur.error, path: cur.path };

  const m = mergeSettings(cur.json, env);
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });

  let backupPath = null;
  if (cur.exists) {
    try {
      backupPath = backupFile(file, BAK);
    } catch (e) {
      return { ok: false, error: '备份失败，已放弃写入：' + e.message, path: file };
    }
  }

  const text = JSON.stringify(m.settings, null, 2) + '\n';
  const tmp = file + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file); // Windows 上 rename 也会覆盖已存在的目标
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* 清不掉就算了 */
    }
    return { ok: false, error: '写入失败：' + e.message, path: file, backupPath };
  }

  pruneBackups(file);
  return { ok: true, path: file, backupPath, added: m.added, changed: m.changed, same: m.same };
}

// 撤销：从最近一次备份还原（还原前也备份当前内容，避免误操作不可挽回）
export function restoreLatest(file = settingsPath()) {
  const backups = listBackups(file);
  if (!backups.length) return { ok: false, error: '没有可用的备份', path: file };
  const from = backups[backups.length - 1];

  // 还原前先把当前内容存一份。这里必须保证安全备份不会覆盖 from ——
  // 否则「刚写完就点还原」会把要还原的那份毁掉（uniquePath 已保证两者不同名）。
  let safety = null;
  if (fs.existsSync(file)) {
    try {
      safety = backupFile(file, PRE_RESTORE);
    } catch (e) {
      return { ok: false, error: '还原前的安全备份失败，已放弃：' + e.message, path: file };
    }
    if (safety === from) return { ok: false, error: '安全备份与待还原的备份同名，已放弃（不会覆盖你的备份）', path: file };
  }
  try {
    fs.copyFileSync(from, file);
  } catch (e) {
    return { ok: false, error: '还原失败：' + e.message, path: file };
  }
  pruneBackups(file);
  return { ok: true, path: file, restoredFrom: from, safetyBackup: safety };
}
