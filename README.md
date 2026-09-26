# Cline Pass Switcher —— 桌面版

把 `cline-pass-switcher` 那套「Cline Pass 上游观察 / 切换代理」装进一个 Electron 桌面程序：
装完就有窗口、有托盘、有开机自启，不用开终端、不用敲命令，也不用碰网页配置。

代理内核完全是原来那份零依赖 Node 代码（`server.js` 逐字搬过来，只在文件尾部做了外科手术，见下文），
所以命令行版积累的学习结果（渠道清单、可用性状态、请求历史）可以直接接着用。

---

## 它解决什么问题

Cline Pass 的订阅模型（`cline-pass/*`）请求体里的 `provider.*` 会被 Cline 网关**丢掉**，改由网关的规划器
自己挑上游；只有目录模型里的 `:free` 变体才会把 `provider.only` 真正透传到 OpenRouter。
于是「我到底被路由到了哪个上游、能不能固定住、固定的那个还活着吗」这件事，光看客户端是看不出来的。

这个程序把这件事做成可视化的：

| 能力 | 说明 |
|---|---|
| 管道识别 | 探测每个模型走 `direct`（OpenRouter，注入顶层 `provider`）还是 `planner`（Vercel AI Gateway，注入 `providerOptions.gateway`） |
| 渠道枚举 | 从一次极小额真实请求的响应元数据里，读出该模型可用的上游清单 |
| 有序钉住 | 给每个模型配一条「钉住链」：按顺序逐个尝试，前一个异常自动顺切下一个；另有排除列表（优先级高于勾选） |
| 钉住校验 | 把链上每个渠道各钉一次，实测能否被网关采纳，结果落盘成状态（可用 / 限流 / 不可钉 / 密钥问题） |
| 账号池 | 多账号轮询或手动指定，单账号连通性测试 |
| 官方额度 | 直接读 Cline 用量接口的 5 小时 / 本周 / 本月三个窗口 |
| 请求历史 | 每条代理请求实际命中的上游、背后模型、耗时、尝试路径、命中账号 |
| 用量统计 | Token / 缓存命中 / 花费的按天趋势与逐条明细。经代理的请求用**上游返回的真实成本**；再扫 Claude Code 的会话记录补上没走代理的请求（去重后合并），所以**不开代理也能统计** |
| 桌面集成 | 托盘常驻、关闭到托盘、开机自启、端口/密钥在窗口里改、一键导出导入配置 |
| CC Switch 集成 | 一条 `ccswitch://` 深链接把本机代理做成 CC Switch 的供应商，含用量查询脚本 |
| 双协议 | 代理同时提供 `/v1/chat/completions`（OpenAI）与 `/v1/messages`（Anthropic），Claude Code 可直连，不必再靠第三方做协议转换 |
| 写入 Claude Code 配置 | 一键把本机代理写进 `~/.claude/settings.json`（只动自己的键、写前备份、可还原），Claude Code 直连代理 |

对下游而言它同时是两种代理：

- **OpenAI 兼容**：Base URL 填 `http://127.0.0.1:<端口>/v1`，走 `/v1/chat/completions`
- **Anthropic Messages**：`ANTHROPIC_BASE_URL` 指向本端口，走 `/v1/messages`。上游只认 Chat，Anthropic 这一侧由代理翻译（请求、响应、流式 SSE 双向），所以 Claude Code 可以直连，不需要 cc-switch 之类的工具替它转换

两种协议都支持工具调用（`tool_use` / `tool_calls` 双向映射）与流式。模型名照抄 `cline-pass/xxx`。

---

## 快速开始

### 直接装（Windows）

到 `dist/` 取构建产物：

- `ClinePassSwitcher-Setup-<版本>.exe` —— 安装版（可选安装目录、创建桌面与开始菜单快捷方式）
- `ClinePassSwitcher-Portable-<版本>.exe` —— 免安装单文件

首次启动后到「账号池」添加 Cline Pass 的 API Key（`sk_` 开头）并保存，代理即可用。

### 从源码跑

```bash
npm install
npm run dev          # 开发模式直接起窗口
node src/main/engine/engine.js   # 只跑命令行版内核（等价于原 server.js）
```

### 打包

```bash
npm run dist:win     # Windows：nsis 安装包 + 免安装单文件（x64）
npm run dist:mac     # macOS：dmg（x64 + arm64）—— 必须在 macOS 上执行
npm run pack         # 只生成未打包的目录（调试用）
```

国内网络下载 Electron 与打包工具链会慢，脚本已按需支持镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm run dist:win
```

> `dmg` 只能在 macOS 上打（需要 `hdiutil`）。Windows 上可以打 Windows 包，反之亦然。

---

## 目录结构

```
src/
  main/
    main.js                Electron 主进程：窗口、托盘、生命周期、IPC、把引擎托起来
    claude-config.js       写 ~/.claude/settings.json 的合并/备份/还原逻辑（纯函数可单测）
    preload.cjs            预加载脚本（CJS：sandbox 下预加载必须是 CommonJS）
    engine/
      engine.js            代理内核（原 server.js，尾部改成可被 import 的 start/stop）
      public/index.html    代理端口根路径的落地页
  renderer/                界面（无框架，原生 DOM + 经典 <script>）
    index.html             自绘标题栏 + 侧边导航 + 视图容器 + 日志抽屉
    styles.css             深色主题；数据色板经 dataviz 校验器在本应用面板色上验证
    js/
      util.js              DOM / 格式化 / 提示 / 模态 / 徽标 / 计量条
      ccswitch.js          导入到 CC Switch：构造 ccswitch:// 深链接与用量脚本
      claudeconfig.js      写入 Claude Code 配置：预览/确认/还原 ~/.claude/settings.json
      api.js               内嵌引擎 HTTP API 的封装
      app.js               外壳：引导、路由、引擎状态、日志抽屉
      views/               overview / accounts / models / playground / history / catalog / settings
resources/seed/            首次运行注入的初始学习结果
build/icon.png             应用图标（由 scripts/make-icon.mjs 生成）
scripts/make-icon.mjs      零依赖图标生成器
```

### 主进程与渲染层的分工

- 引擎（HTTP 代理 + `/api/*` 控制面）跑在**主进程**里，监听 `127.0.0.1`，出厂默认端口 `3123`（与命令行版一致）。
- 渲染层是纯静态页面，通过 `fetch` 调 `http://127.0.0.1:<端口>/api/*` 读写配置。
- 两件事必须走主进程 IPC，不能放渲染层：
  - **用量接口** `quota:fetch`：跨域直连 Cline 会被 CORS 挡住。
  - **真实代理调用** `proxy:chat`：`X-Cline-*` 响应元数据在渲染层的 fetch 里读不到。
- 窗口开了 `contextIsolation` + `sandbox`，渲染层只有 `window.cp` 这一组受控能力，拿不到 Node。

### 数据放在哪

引擎沿用原有的 `DATA_DIR` 约定，主进程在导入引擎**之前**把它设成 Electron 的用户数据目录：

| 平台 | 路径 |
|---|---|
| Windows | `%APPDATA%\Cline Pass Switcher\` |
| macOS | `~/Library/Application Support/Cline Pass Switcher/` |
| Linux | `~/.config/Cline Pass Switcher/` |

里面是：

- `config.json` —— 端口、账号池、下游密钥（`proxyKey`）、`publicBaseUrl`、每个模型的钉住配置。**含明文密钥，不要外传。**
- `metadata.json` —— 学习结果：渠道清单与状态、目录缓存、请求历史（最近 100 条）。
- `usage/` —— 用量统计账本，单独一个目录（**不混进 metadata.json**，理由见下）：
  - `usage.jsonl` —— 逐条请求明细，只追加、从不重写
  - `usage_daily.json` —— 按天 × 账号 × 渠道 × 模型的汇总（趋势图读它，不必扫全量明细）
  - `usage_sync.json` —— 会话记录扫描的增量游标
  - `pricing.json` —— 你自己的模型单价（可选，覆盖内置表）
- `app-settings.json` —— 桌面行为：开机自启、关闭到托盘、窗口尺寸、上次停留的视图。

「设置 → 数据」里可以直接打开这个目录，或者导出 / 导入配置。

---

## 导入到 CC Switch

[CC Switch](https://github.com/farion1231/cc-switch) 是 Claude Code / Codex 的供应商切换器。本程序的
「概览 → 客户端接入」和「设置 → 数据」里都有一个 **导入到 CC Switch** 按钮：选好模型别名后点确认，
它会打开 CC Switch 自己的「确认导入供应商配置」弹窗，核对无误再点导入。

### 为什么走深链接，而不是直接改它的数据库

CC Switch v3 起把供应商存在 SQLite（`~/.cc-switch/cc-switch.db`）里。一次「导入」要同时做四件事——
新增 providers 行、写 live 配置、切换当前供应商、保存用量脚本——这几步由它自己的 `ProviderService`
保证一致性。外部直接写库等于绕过这一整套，迟早会写歪。所以这里只生成一条 `ccswitch://v1/import`
深链接交给它，落盘的事它自己干。

### 深链接里带了什么

| 字段 | 内容 |
|---|---|
| `endpoint` / `homepage` | 本机代理地址（默认 `http://127.0.0.1:3199/v1`）；设了公网代理地址也可以选那条 |
| `model` 及三个别名 | 同一个模型同时写进 `ANTHROPIC_MODEL`、`ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS}_MODEL`，Claude Code 里切 Opus / Sonnet / Haiku 都走这条上游 |
| `config.env` | `ANTHROPIC_DEFAULT_FABLE_MODEL` 与 `CLAUDE_CODE_SUBAGENT_MODEL`，让 Fable 和子代理也不漏回 Anthropic 官方 |
| `usageScript` | cc-switch 的用量脚本契约 `({ request, extractor })`，用 `{{apiKey}}` / `{{baseUrl}}` 占位符读 Cline 官方的 5 小时 / 本周 / 本月额度 |

### 两个容易踩的点

- **用量脚本要的是 Cline 账号的 key，不是本机代理的密钥。** 额度接口认的是上游账号，所以
  `usageApiKey` 取账号池里第一个启用账号的 `sk_` 密钥（Bearer 鉴权即可，不需要 cookie）。
- **cc-switch 要求 API Key 非空，而本机代理默认免鉴权。** 这种情况会填占位符
  `local-proxy-no-key`——代理不校验它，能用；想要真密钥就到「设置 → 访问与安全」生成一个。

> 深链接里含明文密钥，别往聊天窗口或别处粘贴。

---

## 对内核做的唯一改动

`src/main/engine/engine.js` 是原 `server.js` 的逐字副本，只有**文件尾部**被替换：
原来的 `http.createServer(...)` / `server.listen(...)` 那一段，改成导出一组函数，并加了「直接运行才自启」的判断。

```js
export { start, stop, config, META, saveConfig, saveMeta, isConfigured, publicProxyBase,
         enabledAccounts, probeModel, validateUpstreams, fetchOfficialModels, learnUpstreamStatus };

const isDirectRun = (() => {
  try { return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isDirectRun) start().then(...).catch(...);
```

`start({ host, port })` 返回 `Promise<{ host, port }>`（`EADDRINUSE` 会 reject，界面据此提示换端口），
`stop()` 先 `closeAllConnections()` 再 `close()`，这样重启服务不会挂住长连接。
中间九百多行上游探测 / 钉住 / 回退逻辑**一行没动**——那是这个项目最贵的部分。

---

## 写入 Claude Code 配置

「概览 → 客户端接入」和「设置 → 数据」里都有一个 **写入 Claude Code 配置** 按钮：它把本机代理的
环境变量合并进 `~/.claude/settings.json`，Claude Code 就直接连本机代理，不用中间人。

写入的是这 12 个键（`*_MODEL` 与 `*_MODEL_NAME` 写同一个真模型名，Claude Code 里切
Haiku / Sonnet / Opus / Fable 或派子代理都不会漏回 Anthropic 官方）：

```
ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL
ANTHROPIC_DEFAULT_{HAIKU,SONNET,OPUS,FABLE}_MODEL 及其 _NAME
CLAUDE_CODE_SUBAGENT_MODEL
```

### 它对你的配置做的事

| 行为 | 说明 |
|---|---|
| 只动自己的键 | `settings.json` 里的其他顶层键（permissions、hooks…）与其他 env 键一律原样保留，不做整体覆盖 |
| 写前必留备份 | 备份到 `settings.json.bak-<时间戳>`，弹窗底部有 **从备份还原** |
| 非法 JSON 拒绝写入 | 已有文件不是合法 JSON 时**直接放弃**，不做猜测性修复，原文件一个字节都不动 |
| 写入是原子的 | 先写临时文件再改名，不会出现写了一半的配置 |
| 还原是幂等的 | 连点多次「还原」始终停在写入前的状态（还原前的安全备份另存为 `.pre-restore-`，不会被当成还原目标） |

### 两个必须知道的点

1. **如果这个文件正被供应商切换器（cc-switch 之类）管理**，弹窗会明确警告：在那边切换供应商时它
   会重写这个文件，你写进去的会被覆盖。两边选一个用 —— 要么在本程序里直连，要么继续走那边的中转。
2. **写完后要重启 Claude Code**（或新开一个会话）环境变量才生效。

> Claude Code 可能提示 `<模型名> isn't described by this version's model catalog` —— 那只是它不认识
> 这个模型名、按 200k 假设上下文窗口，不影响使用。想消掉可以设 `CLAUDE_CODE_MAX_CONTEXT_TOKENS`。

---

## 用量统计

「用量统计」视图给出请求数、Token、缓存命中率、花费的按天趋势与逐条明细。数据有**两个来源**，
合并时按请求 id 去重，所以同一笔不会算两次：

| 来源 | 覆盖 | Token | 花费 |
|---|---|---|---|
| **代理** | 经本机代理的请求 | 上游返回的 `usage` | **上游网关的真实成本**（`provider_metadata.gateway.cost`）|
| **会话** | 点「扫描会话记录」补进来的、没走代理的请求 | Claude Code 会话文件里的 `usage` | 定价表估算（标记为「估」）|

### 为什么花费要分「真实」和「估算」

走代理时，上游会在响应的最后一个分片里带上它自己算的账单金额。那是**最准的数字**，直接采信。
会话记录里没有这个字段，只有 token 数 —— 于是用定价表（内置 220 条，源自 models.dev）估算，
并在界面上明确标成「估」。两者在汇总里分开累计，**不把估价混进真实账单里冒充**。

内置的定价表覆盖常见模型；要给你自己的模型定价，写 `usage/pricing.json`，或调
`POST /api/usage/pricing`，格式 `{ "模型名": { "i": 输入价, "o": 输出价, "cr": 缓存读, "cc": 缓存写 } }`，
单位是美元 / 百万 token。自定义项优先级高于内置表。

### 不开代理也能统计

「扫描会话记录」会读 Claude Code 的会话文件（默认 `~/.claude/projects/**/*.jsonl`，
也认 `CLAUDE_CONFIG_DIR`），按**增量**扫描：记住每个文件的读取偏移，只解析新增字节，
所以第二次扫描快得多（实测 103 个文件：首次 312ms，二次 5ms）。文件被截断或重写时自动从头重扫。

去重是**必需**的，不是优化：实测 8747 条会话记录里有 308 个重复的 `message.id`
（Claude Code 会给同一次响应的多个内容块各写一行），不去重会让统计虚高约 40%。

### 为什么单独存一个 `usage/` 目录

`metadata.json` 是「渠道学习结果」，每次请求同步全量覆写，且已有 100 条历史上限。
把逐条用量塞进去会：把渠道学习数据一起置于截断风险中、让每次请求的写盘量膨胀到 MB 级。
所以明细走 **append-only 的 `usage.jsonl`** —— 追加写、永不重写，崩溃最多丢最后一行。
按天汇总另存一个小文件供趋势图快速读取。

「清理旧明细」可以删掉 90 天以前的逐条记录（按天汇总与总计不受影响）。

> **Token 口径**：界面上统一用 Anthropic 口径 —— `input` 是**不含缓存**的部分，缓存单列。
> 上游 OpenAI 口径的 `prompt_tokens` 是含缓存的，代理会把它减掉再算。不这么做的话，
> 缓存命中越多、上下文读数偏得越狠（实测有单次命中 53 万 token 的请求）。

---

## 测试

代理的协议翻译（Anthropic ↔ OpenAI Chat）与用量统计都有分层测试，都能单独跑：

| 命令 | 测什么 | 需要上游吗 |
|---|---|---|
| `npm run test:unit` | `anthropic.js` 的请求/响应/流式状态机（含跨 chunk 缓冲、事件序列、工具参数分片） | 否 |
| `npm run test:live` | 真实上游：非流式、流式、工具调用、工具结果回灌、count_tokens、路径写法，以及 `/v1/chat/completions` 的回归 | 是 |
| `npm run test:auth` | 鉴权：`x-api-key`（Claude Code 用的）与 `Authorization: Bearer`，以及控制台接口的鉴权 | 否（只 count_tokens 打上游） |
| `npm run test:claudecfg` | 写 `~/.claude/settings.json` 的合并、备份、还原、非法 JSON 拒绝写入（全程在临时目录，不碰真实配置） | 否 |
| `npm run test:usage` | 用量统计核心：token 口径换算、定价查找与估算、按天汇总、去重、明细裁剪、会话增量扫描 | 否 |
| `npm run test:usage-live` | 用量统计端到端：起隔离实例打真实上游，验证 token/缓存/成本真被记下、跨源去重、定价覆盖 | 是 |
| `npm run test:e2e` | **真实 Claude Code 客户端**指向本机代理，跑一轮对话 + 一轮工具调用 | 是 |
| `npm run test:usage-e2e` | 同上，另验证：停掉代理后靠会话扫描仍能统计到用量 | 是 |

后三个用环境变量指定目标，默认打在 3251 端口的测试实例上：

```bash
# 在另一个端口起一个隔离实例（用自己的配置副本，不碰正在跑的那个）
DATA_DIR=/tmp/eng-test node src/main/engine/engine.js

BASE=http://127.0.0.1:3251 PROXY_KEY=<代理密钥> npm run test:live
BASE=http://127.0.0.1:3251 KEY=<代理密钥> npm run test:e2e
```

`npm run probe` 是上游健康度探针：直接问 Cline 上游，确认某个模型现在是否可用。

> 注意：用 `curl` 从 Git Bash 发带中文的请求体会被按 GBK 编码发出去，上游收到乱码。
> 测试脚本一律用 Node 的 fetch（UTF-8），别用 curl 拼中文。

---

## 已知边界

- **端口与命令行版冲突**：两者出厂默认都是 `3123`。同时开的话后启动的一方会报「端口已被占用」，
  到「设置」里换一个端口、点「重启服务」即可（界面会直接给这个提示）。
  本机已把桌面版的端口预先设成 `3199`，因为命令行版正占着 `3123`；想让下游客户端不用改配置，
  就停掉命令行版再把这里改回 `3123`。
- **只监听 `127.0.0.1`**：内嵌服务不对局域网开放。要让别的设备用，得自己在前面加反向代理，
  `publicBaseUrl` 只用于界面展示地址。
- **渠道校验要花额度**：「校验全部渠道」会对每个渠道各发一次最小请求，渠道多时耗时数分钟。
- **`empty response content` 不一定是故障**：部分推理模型会把 `max_tokens` 全用在思考上导致内容为空。
  内核会把这类错误归类成「上游可达」，界面上表现为该渠道仍算可用。
- **未签名**：构建产物没有代码签名证书，Windows SmartScreen / macOS Gatekeeper 会拦一次，
  选择「仍要运行」即可；要发布给别人请自备证书。

---

## 许可

MIT。
