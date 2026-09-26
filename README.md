# Cline Pass Switcher —— 桌面版

[中文](README.md) · [English](README.en.md)

把 Cline Pass 的**上游观察 / 切换代理**装进一个桌面程序：有窗口、有托盘、有开机自启，
不用开终端、不用敲命令。

## 界面

**概览** —— 代理状态、客户端接入地址、账号额度：

![概览](docs/screenshots/overview.png)

**用量统计** —— 趋势、人民币花费、逐条明细，随请求实时更新：

![用量统计](docs/screenshots/usage.png)

> 截图用演示数据，账号名与密钥已替换。

## 它解决什么问题

Cline Pass 订阅模型（`cline-pass/*`）请求体里的 `provider.*` 会被网关**丢掉**，改由网关自己挑上游。
于是「我到底被路由到哪个上游、能不能固定住、固定的那个还活着吗」——光看客户端是看不出来的。

| 能力 | 说明 |
|---|---|
| 管道识别 | 探测模型走 `direct`（OpenRouter）还是 `planner`（Vercel AI Gateway） |
| 渠道枚举 | 从一次极小额真实请求的响应元数据里读出可用上游清单 |
| 有序钉住 | 每个模型配一条钉住链，按序尝试、异常自动顺切；另有排除列表 |
| 钉住校验 | 链上每个渠道各钉一次，实测可用性并落盘成状态 |
| 账号池 | 多账号轮询或手动指定，含官方额度（5 小时 / 本周 / 本月） |
| 请求历史 | 每条请求实际命中的上游、背后模型、耗时、命中账号 |
| 用量统计 | Token / 缓存 / 花费趋势（当天按小时、7/31/60/90 天）与明细，实时更新 |
| 人民币计价 | DeepSeek 按官方价目表计费（含峰谷），与美元账单**并列不合并** |
| 双协议 | 同时提供 `/v1/chat/completions` 与 `/v1/messages`，Claude Code 可直连 |
| 写入 Claude Code 配置 | 一键写进 `~/.claude/settings.json`（只动自己的键、写前备份、可还原） |
| 中英双语 | 跟随系统语言，也可在设置里指定 |

## 快速开始

**装**：从 [Releases](https://github.com/lnsane/cline-pass-switcher-desktop/releases) 下载
`ClinePassSwitcher-Setup-<版本>.exe`（安装版）或 `-Portable-<版本>.exe`（免安装单文件）。
首次启动到「账号池」添加 Cline Pass 的 API Key（`sk_` 开头）并保存即可用。

> 安装包**未签名**。Windows 开了 Smart App Control 会拦安装版 —— 改用免安装版即可。

**源码跑**：

```bash
npm install
npm run dev          # 起窗口
```

**本地构建**（比打包快，也不受签名限制）：

```bat
scripts\build-win.bat        :: Windows，可双击
```
```bash
bash scripts/build-mac.sh    # macOS
```

都支持 `--clean`（先删 `dist/`）、`--run`（构建完直接启动）。
注意：脚本只能构建**本平台**产物，要出另一平台的包请推 tag 让 CI 打。

## 客户端接入

| 客户端 | 填什么 |
|---|---|
| OpenAI 兼容 | Base URL `http://127.0.0.1:3199/v1` |
| Claude Code | `ANTHROPIC_BASE_URL=http://127.0.0.1:3199` |

模型名照抄 `cline-pass/xxx`。两种协议都支持工具调用与流式。

## 用量统计

数据有**两个来源**，按请求 id 去重后合并 —— 所以**不开代理也能统计**：

| 来源 | 花费 |
|---|---|
| 经本机代理的请求 | **上游网关的真实账单** |
| 扫 Claude Code 会话记录补的 | 定价表估算（标「估」） |

DeepSeek 系列另按**官方人民币价目表**计价（元/百万 token）：

| 模型 | 缓存命中 | 未命中 | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

每格是「空闲 / 高峰」。高峰为北京时间周一至周五（不含法定节假日）9:00-12:00、14:00-18:00，
其余时段空闲，**空闲价恰为高峰的一半**。

两点必须说清楚：

- **两个币种不合并**。人民币来自官方价目表、与渠道无关；美元是上游真实账单。
  相加或按汇率折算都会得到一个含汇率假设的假数字，所以各计各的。
- 只有 DeepSeek 有官方人民币价，其他模型（k3 / glm / qwen 等）保持「无人民币价」，
  不拿别的价格顶成 ¥0。

> 老数据显示 ¥0 是正常的 —— 人民币计价是后加的能力。点明细区的**「重算人民币」**
> 按官方价目表重推全部历史即可补上（幂等，点几次都一样）。

## 写入 Claude Code 配置

「概览 → 客户端接入」和「设置 → 数据」里都有这个按钮，把本机代理写进 `~/.claude/settings.json`：

- 只动它自己负责的键，其余原样保留；写前自动备份，可一键还原
- 上下文窗口可选 **200K（默认）/ 1M**。选 1M 写 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=1000000`；
  换回 200K 会**真的把这个键删掉**（合并式写入删不掉键，不显式删就会「看着改了其实没改」）
- 写超时重算：上游拒绝超过其实际能力的窗口，界面上会拿探测到的真实窗口校验你的选择
- 写完需重启 Claude Code（或新开会话）才生效

## 测试

```bash
npm run test:unit          # 协议翻译状态机
npm run test:usage         # 用量统计核心
npm run test:cny           # DeepSeek 人民币计价（含跨时区校验）
npm run test:usage-offline # 用量端到端（纯离线）
npm run test:claudecfg     # 配置写入 / 备份 / 还原
npm run test:context       # 上下文窗口档位
npm run test:i18n          # 双语覆盖
```

要真实账号密钥的（`test:live` / `test:e2e` / `test:usage-live`）**不进 CI**，
本地用 `BASE=` `KEY=` 指定目标手动跑。

## 已知边界

- **端口冲突**：默认 `3123`，与命令行版相同。同时跑两个要改端口。引擎**绝不杀**占用端口的进程，
  只会报 `EADDRINUSE` 让你换一个。
- **未签名**：Windows Smart App Control 会拦安装版（用免安装版），macOS 首次打开被 Gatekeeper 拦
  （右键 → 打开，或 `xattr -cr`）。
- **只监听 `127.0.0.1`**：不对局域网开放，要给别的设备用需自加反向代理。

## 许可

MIT。
