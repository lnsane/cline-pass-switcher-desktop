// 用量统计：请求级明细 + 按天汇总 + 定价估算
//
// 设计要点（为什么要单独一个文件，而不是塞进 metadata.json）：
//
// 1. metadata.json 是「渠道学习结果」，每次请求同步全量覆写，且已有 100 条历史上限。
//    把逐条用量塞进去会把它一起置于截断风险中，也会让每次请求写盘量膨胀到 MB 级。
// 2. 所以明细走 **append-only 的 JSONL**（usage.jsonl）——追加写，永不重写，
//    崩溃最多丢最后一行，不会毁掉已有数据。按天汇总另存一个小的 usage_daily.json，
//    供趋势图快速读取，不必每次去扫全量明细。
// 3. 会话扫描（不开代理也能统计）走增量：记录每个会话文件的读取偏移，
//    只解析新增的字节。文件被截断/重写时自动从头重扫。
//
// 两套数据源（对齐 cc-switch 的做法）：
// - proxy：经本机代理的请求。带**上游返回的真实成本**（provider_metadata.gateway.cost），
//   比定价表估算准得多，所以优先采信。
// - session：扫描 Claude Code 的 ~/.claude/projects/**/*.jsonl。覆盖不经代理的请求。
//   同一请求会同时出现在两边（实测 764 条代理记录里 724 条能在会话文件里找到），
//   所以必须按请求 id 去重 —— 代理那侧已记录过的，扫描时跳过。
//
// Token 语义统一成 Anthropic 口径（input / cache_read / cache_creation / output）：
// 因为这是 Claude Code 生态，会话记录本来就是这个口径，能直接对上。
// 上游的 OpenAI 口径要换算：cache_read = prompt_tokens_details.cached_tokens，
// input = prompt_tokens - cache_read（OpenAI 的 prompt_tokens 是含缓存的）。
import fs from 'node:fs';
import path from 'node:path';

// ---------- 定价 ----------
// 单位：美元 / 百万 token。来源为 models.dev（与 cc-switch 同源），只内置常用项；
// 用户自定义的部分存在 pricing.json 里，优先级高于这张表。
// 单位：美元 / 百万 token。i=输入 o=输出 cr=缓存读 cc=缓存写。
// 来源 models.dev（与 cc-switch 同源）。用户自定义的 pricing.json 优先级更高（见 createUsageStore）。
const BUILTIN_PRICING = {
  "claude-3-5-haiku-20241022": { n: "Claude 3.5 Haiku", i: 0.8, o: 4, cr: 0.08, cc: 1 }, "claude-3-5-sonnet-20241022": { n: "Claude 3.5 Sonnet", i: 3, o: 15, cr: 0.3, cc: 3.75 },
  "claude-fable-5": { n: "Claude Fable 5", i: 10, o: 50, cr: 1, cc: 12.5 }, "claude-fable-5-1": { n: "Claude Fable 5.1", i: 10, o: 50, cr: 0.25, cc: 12.5 },
  "claude-haiku-4-5-20251001": { n: "Claude Haiku 4.5", i: 1, o: 5, cr: 0.1, cc: 1.25 }, "claude-mythos-5": { n: "Claude Mythos 5", i: 10, o: 50, cr: 1, cc: 12.5 },
  "claude-mythos-5-1": { n: "Claude Mythos 5.1", i: 10, o: 50, cr: 0.25, cc: 12.5 }, "claude-opus-4-1-20250805": { n: "Claude Opus 4.1", i: 15, o: 75, cr: 1.5, cc: 18.75 },
  "claude-opus-4-20250514": { n: "Claude Opus 4", i: 15, o: 75, cr: 1.5, cc: 18.75 }, "claude-opus-4-5-20251101": { n: "Claude Opus 4.5", i: 5, o: 25, cr: 0.5, cc: 6.25 },
  "claude-opus-4-6": { n: "Claude Opus 4.6", i: 5, o: 25, cr: 0.5, cc: 6.25 }, "claude-opus-4-6-20260206": { n: "Claude Opus 4.6", i: 5, o: 25, cr: 0.5, cc: 6.25 },
  "claude-opus-4-7": { n: "Claude Opus 4.7", i: 5, o: 25, cr: 0.5, cc: 6.25 }, "claude-opus-4-8": { n: "Claude Opus 4.8", i: 5, o: 25, cr: 0.5, cc: 6.25 },
  "claude-opus-5": { n: "Claude Opus 5", i: 5, o: 25, cr: 0.5, cc: 6.25 }, "claude-opus-5-5": { n: "Claude Opus 5.5", i: 4, o: 20, cr: 0.2, cc: 5 },
  "claude-sonnet-4-20250514": { n: "Claude Sonnet 4", i: 3, o: 15, cr: 0.3, cc: 3.75 }, "claude-sonnet-4-5-20250929": { n: "Claude Sonnet 4.5", i: 3, o: 15, cr: 0.3, cc: 3.75 },
  "claude-sonnet-4-6": { n: "Claude Sonnet 4.6", i: 3, o: 15, cr: 0.3, cc: 3.75 }, "claude-sonnet-4-6-20260217": { n: "Claude Sonnet 4.6", i: 3, o: 15, cr: 0.3, cc: 3.75 },
  "claude-sonnet-5": { n: "Claude Sonnet 5", i: 2, o: 10, cr: 0.2, cc: 2.5 }, "cline-pass/deepseek-v4.1-flash": { n: "cline-pass/deepseek-v4.1-flash", i: 0.2, o: 0.2, cr: 0.004, cc: 0.004 },
  "codestral-2508": { n: "Codestral", i: 0.3, o: 0.9, cr: 0.03, cc: 0 }, "codex-mini": { n: "Codex Mini", i: 0.75, o: 3, cr: 0.025, cc: 0 },
  "command-a": { n: "Cohere Command A", i: 2.5, o: 10, cr: 0, cc: 0 }, "command-r": { n: "Cohere Command R", i: 0.15, o: 0.6, cr: 0, cc: 0 },
  "command-r-plus": { n: "Cohere Command R+", i: 2.5, o: 10, cr: 0, cc: 0 }, "deepseek-chat": { n: "DeepSeek Chat", i: 0.44, o: 1.32, cr: 0.014, cc: 0 },
  "deepseek-flash": { n: "DeepSeek V4.1 Flash", i: 0.15, o: 0.6, cr: 0.003, cc: 0 }, "deepseek-reasoner": { n: "DeepSeek Reasoner", i: 0.44, o: 1.32, cr: 0.014, cc: 0 },
  "deepseek-v3": { n: "DeepSeek V3", i: 0.28, o: 1.11, cr: 0.028, cc: 0 }, "deepseek-v3.1": { n: "DeepSeek V3.1", i: 0.55, o: 1.67, cr: 0.055, cc: 0 },
  "deepseek-v3.2": { n: "DeepSeek V3.2", i: 0.28, o: 0.42, cr: 0.028, cc: 0 }, "deepseek-v4-flash": { n: "DeepSeek V4 Flash", i: 0.3, o: 1.2, cr: 0.006, cc: 0 },
  "deepseek-v4-flash-0731": { n: "DeepSeek V4 Flash", i: 0.3, o: 1.2, cr: 0.006, cc: 0 }, "deepseek-v4-flash-vision-exp": { n: "DeepSeek V4 Flash Vision Exp", i: 0.3, o: 1.2, cr: 0.006, cc: 0 },
  "deepseek-v4-pro": { n: "DeepSeek V4 Pro", i: 0.435, o: 0.87, cr: 0.003625, cc: 0 }, "deepseek/deepseek-v4.1-flash": { n: "claude-opus-5", i: 0.02, o: 0.02, cr: 0.002, cc: 0.002 },
  "devstral-2-2512": { n: "Devstral 2", i: 0.4, o: 2, cr: 0.04, cc: 0 }, "devstral-medium": { n: "Devstral Medium", i: 0.4, o: 2, cr: 0.04, cc: 0 },
  "devstral-small-1.1": { n: "Devstral Small 1.1", i: 0.07, o: 0.28, cr: 0.01, cc: 0 }, "devstral-small-2-2512": { n: "Devstral Small 2", i: 0.1, o: 0.3, cr: 0.01, cc: 0 },
  "doubao-seed-2-0-code": { n: "Doubao Seed 2.0 Code", i: 0.47, o: 2.37, cr: 0.09, cc: 0 }, "doubao-seed-2-0-code-preview-latest": { n: "Doubao Seed 2.0 Code Preview", i: 0.47, o: 2.37, cr: 0.09, cc: 0 },
  "doubao-seed-2-0-lite": { n: "Doubao Seed 2.0 Lite", i: 0.08, o: 0.5, cr: 0.017, cc: 0 }, "doubao-seed-2-0-mini": { n: "Doubao Seed 2.0 Mini", i: 0.03, o: 0.31, cr: 0.0056, cc: 0 },
  "doubao-seed-2-0-pro": { n: "Doubao Seed 2.0 Pro", i: 0.47, o: 2.37, cr: 0.09, cc: 0 }, "doubao-seed-2-1-pro": { n: "Doubao Seed 2.1 Pro", i: 0.84, o: 4.2, cr: 0.17, cc: 0 },
  "doubao-seed-2-1-turbo": { n: "Doubao Seed 2.1 Turbo", i: 0.42, o: 2.1, cr: 0.08, cc: 0 }, "doubao-seed-code": { n: "Doubao Seed Code", i: 0.17, o: 1.11, cr: 0.02, cc: 0 },
  "gemini-2.0-flash": { n: "Gemini 2.0 Flash", i: 0.1, o: 0.4, cr: 0.025, cc: 0 }, "gemini-2.5-flash": { n: "Gemini 2.5 Flash", i: 0.3, o: 2.5, cr: 0.03, cc: 0 },
  "gemini-2.5-flash-lite": { n: "Gemini 2.5 Flash Lite", i: 0.1, o: 0.4, cr: 0.01, cc: 0 }, "gemini-2.5-pro": { n: "Gemini 2.5 Pro", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gemini-3-flash-preview": { n: "Gemini 3 Flash Preview", i: 0.5, o: 3, cr: 0.05, cc: 0 }, "gemini-3-pro-preview": { n: "Gemini 3 Pro Preview", i: 2, o: 12, cr: 0.2, cc: 0 },
  "gemini-3.1-flash-lite": { n: "Gemini 3.1 Flash Lite", i: 0.25, o: 1.5, cr: 0.025, cc: 0 }, "gemini-3.1-flash-lite-preview": { n: "Gemini 3.1 Flash Lite Preview", i: 0.25, o: 1.5, cr: 0.025, cc: 0 },
  "gemini-3.1-pro-preview": { n: "Gemini 3.1 Pro Preview", i: 2, o: 12, cr: 0.2, cc: 0 }, "gemini-3.5-flash": { n: "Gemini 3.5 Flash", i: 1.5, o: 9, cr: 0.15, cc: 0 },
  "gemini-3.5-flash-lite": { n: "Gemini 3.5 Flash Lite", i: 0.3, o: 2.5, cr: 0.03, cc: 0 }, "gemini-3.6-flash": { n: "Gemini 3.6 Flash", i: 0.75, o: 3.75, cr: 0.075, cc: 0 },
  "gemini-3.7-flash": { n: "Gemini 3.7 Flash", i: 0.75, o: 3.75, cr: 0.075, cc: 0 }, "gemini-3.8-flash": { n: "Gemini 3.8 Flash", i: 0.75, o: 3.75, cr: 0.075, cc: 0 },
  "gemini-flash-latest": { n: "Gemini Flash Latest", i: 0.75, o: 3.75, cr: 0.075, cc: 0 }, "gemini-flash-lite-latest": { n: "Gemini Flash-Lite Latest", i: 0.3, o: 2.5, cr: 0.03, cc: 0 },
  "glm-4.6": { n: "GLM-4.6", i: 0.6, o: 2.2, cr: 0.11, cc: 0 }, "glm-4.7": { n: "GLM-4.7", i: 0.6, o: 2.2, cr: 0.11, cc: 0 },
  "glm-5": { n: "GLM-5", i: 1, o: 3.2, cr: 0.2, cc: 0 }, "glm-5-turbo": { n: "GLM-5-Turbo", i: 1.2, o: 4, cr: 0.24, cc: 0 },
  "glm-5.1": { n: "GLM-5.1", i: 1.4, o: 4.4, cr: 0.26, cc: 0 }, "glm-5.2": { n: "GLM-5.2", i: 1.4, o: 4.4, cr: 0.26, cc: 0 },
  "glm-5.3": { n: "GLM-5.3", i: 1.4, o: 4.4, cr: 0.26, cc: 0 }, "glm-5.3-flash": { n: "GLM-5.3-Flash", i: 0.15, o: 0.5, cr: 0.03, cc: 0 },
  "glm-5.3-flashx": { n: "GLM-5.3-FlashX", i: 0.37, o: 1.25, cr: 0.075, cc: 0 }, "glm-5v-turbo": { n: "GLM-5V-Turbo", i: 1.2, o: 4, cr: 0.24, cc: 0 },
  "gpt-4.1": { n: "GPT-4.1", i: 2, o: 8, cr: 0.5, cc: 0 }, "gpt-4.1-mini": { n: "GPT-4.1 Mini", i: 0.4, o: 1.6, cr: 0.1, cc: 0 },
  "gpt-4.1-nano": { n: "GPT-4.1 Nano", i: 0.1, o: 0.4, cr: 0.025, cc: 0 }, "gpt-5": { n: "GPT-5", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-codex": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5-codex-high": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-codex-low": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5-codex-medium": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-codex-mini": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5-codex-mini-high": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-codex-mini-medium": { n: "GPT-5 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5-high": { n: "GPT-5", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-low": { n: "GPT-5", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5-medium": { n: "GPT-5", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-mini": { n: "GPT-5 Mini", i: 0.25, o: 2, cr: 0.025, cc: 0 }, "gpt-5-minimal": { n: "GPT-5", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5-nano": { n: "GPT-5 Nano", i: 0.05, o: 0.4, cr: 0.005, cc: 0 }, "gpt-5.1": { n: "GPT-5.1", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5.1-codex": { n: "GPT-5.1 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5.1-codex-max": { n: "GPT-5.1 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5.1-codex-max-high": { n: "GPT-5.1 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5.1-codex-max-xhigh": { n: "GPT-5.1 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5.1-codex-mini": { n: "GPT-5.1 Codex", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5.1-high": { n: "GPT-5.1", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5.1-low": { n: "GPT-5.1", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5.1-medium": { n: "GPT-5.1", i: 1.25, o: 10, cr: 0.125, cc: 0 },
  "gpt-5.1-minimal": { n: "GPT-5.1", i: 1.25, o: 10, cr: 0.125, cc: 0 }, "gpt-5.2": { n: "GPT-5.2", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.2-codex": { n: "GPT-5.2 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.2-codex-high": { n: "GPT-5.2 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.2-codex-low": { n: "GPT-5.2 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.2-codex-medium": { n: "GPT-5.2 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.2-codex-xhigh": { n: "GPT-5.2 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.2-high": { n: "GPT-5.2", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.2-low": { n: "GPT-5.2", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.2-medium": { n: "GPT-5.2", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.2-xhigh": { n: "GPT-5.2", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.3-codex": { n: "GPT-5.3 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.3-codex-high": { n: "GPT-5.3 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.3-codex-low": { n: "GPT-5.3 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.3-codex-medium": { n: "GPT-5.3 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.3-codex-spark": { n: "GPT-5.3 Codex Spark", i: 1.75, o: 14, cr: 0.175, cc: 0 },
  "gpt-5.3-codex-xhigh": { n: "GPT-5.3 Codex", i: 1.75, o: 14, cr: 0.175, cc: 0 }, "gpt-5.4": { n: "GPT-5.4", i: 2.5, o: 15, cr: 0.25, cc: 0 },
  "gpt-5.4-mini": { n: "GPT-5.4 Mini", i: 0.75, o: 4.5, cr: 0.075, cc: 0 }, "gpt-5.4-nano": { n: "GPT-5.4 Nano", i: 0.2, o: 1.25, cr: 0.02, cc: 0 },
  "gpt-5.5": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 }, "gpt-5.5-high": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 },
  "gpt-5.5-low": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 }, "gpt-5.5-medium": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 },
  "gpt-5.5-minimal": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 }, "gpt-5.5-xhigh": { n: "GPT-5.5", i: 5, o: 30, cr: 0.5, cc: 0 },
  "gpt-5.6": { n: "GPT-5.6", i: 4, o: 20, cr: 0.4, cc: 5 }, "gpt-5.6-high": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 },
  "gpt-5.6-low": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 }, "gpt-5.6-luna": { n: "GPT-5.6 Luna", i: 0.2, o: 1.2, cr: 0.02, cc: 0.25 },
  "gpt-5.6-medium": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 }, "gpt-5.6-minimal": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 },
  "gpt-5.6-sol": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 }, "gpt-5.6-terra": { n: "GPT-5.6 Terra", i: 2, o: 12, cr: 0.2, cc: 2.5 },
  "gpt-5.6-xhigh": { n: "GPT-5.6 Sol", i: 4, o: 20, cr: 0.4, cc: 5 }, "gpt-6-astra": { n: "GPT-6 Astra", i: 10, o: 50, cr: 1, cc: 12.5 },
  "gpt-6-luna": { n: "GPT-6 Luna", i: 0.1, o: 0.5, cr: 0.01, cc: 0.125 }, "gpt-6-sol": { n: "GPT-6 Sol", i: 2, o: 10, cr: 0.2, cc: 2.5 },
  "grok-3": { n: "Grok 3", i: 3, o: 15, cr: 0.75, cc: 0 }, "grok-3-mini": { n: "Grok 3 Mini", i: 0.25, o: 0.5, cr: 0.075, cc: 0 },
  "grok-4": { n: "Grok 4", i: 3, o: 15, cr: 0.75, cc: 0 }, "grok-4-1-fast-non-reasoning": { n: "Grok 4.1 Fast", i: 0.2, o: 0.5, cr: 0.05, cc: 0 },
  "grok-4-1-fast-reasoning": { n: "Grok 4.1 Fast Reasoning", i: 0.2, o: 0.5, cr: 0.05, cc: 0 }, "grok-4.20-0309-non-reasoning": { n: "Grok 4.20 (Non-Reasoning)", i: 1.25, o: 2.5, cr: 0.2, cc: 0 },
  "grok-4.20-0309-reasoning": { n: "Grok 4.20 Reasoning", i: 1.25, o: 2.5, cr: 0.2, cc: 0 }, "grok-4.3": { n: "Grok 4.3", i: 1.25, o: 2.5, cr: 0.2, cc: 0 },
  "grok-4.5": { n: "Grok 4.5", i: 2, o: 6, cr: 0.3, cc: 0 }, "grok-4.5-build": { n: "Grok 4.5 Build", i: 2, o: 6, cr: 0.3, cc: 0 },
  "grok-4.6": { n: "Grok 4.6", i: 2, o: 6, cr: 0.5, cc: 0 }, "grok-4.7": { n: "Grok 4.7", i: 2, o: 6, cr: 0.5, cc: 0 },
  "grok-build-0.1": { n: "Grok Build 0.1", i: 1, o: 2, cr: 0.2, cc: 0 }, "grok-code-fast-1": { n: "Grok Build 0.1 (Code Fast Alias)", i: 1, o: 2, cr: 0.2, cc: 0 },
  "hunyuan-hy3": { n: "Hunyuan Hy3", i: 0.14, o: 0.56, cr: 0.035, cc: 0 }, "hy3": { n: "Hunyuan Hy3", i: 0.14, o: 0.56, cr: 0.035, cc: 0 },
  "hy4-preview": { n: "Hunyuan Hy4 Preview", i: 0.84, o: 2.52, cr: 0.042, cc: 0 }, "k3": { n: "Kimi K3", i: 3, o: 15, cr: 0.3, cc: 0 },
  "kimi-k2-0905": { n: "Kimi K2", i: 0.55, o: 2.2, cr: 0.1, cc: 0 }, "kimi-k2-thinking": { n: "Kimi K2 Thinking", i: 0.55, o: 2.2, cr: 0.1, cc: 0 },
  "kimi-k2-turbo": { n: "Kimi K2 Turbo", i: 1.11, o: 8.06, cr: 0.14, cc: 0 }, "kimi-k2.5": { n: "Kimi K2.5", i: 0.6, o: 3, cr: 0.1, cc: 0 },
  "kimi-k2.6": { n: "Kimi K2.6", i: 0.95, o: 4, cr: 0.16, cc: 0 }, "kimi-k2.7-code": { n: "Kimi K2.7 Code", i: 0.95, o: 4, cr: 0.19, cc: 0 },
  "kimi-k2.7-code-highspeed": { n: "Kimi K2.7 Code HighSpeed", i: 1.9, o: 8, cr: 0.38, cc: 0 }, "kimi-k3": { n: "Kimi K3", i: 3, o: 15, cr: 0.3, cc: 0 },
  "longcat-2.0": { n: "LongCat-2.0", i: 0.75, o: 2.95, cr: 0.015, cc: 0 }, "magistral-medium": { n: "Magistral Medium", i: 2, o: 5, cr: 0, cc: 0 },
  "magistral-small": { n: "Magistral Small", i: 0.5, o: 1.5, cr: 0, cc: 0 }, "mimo-v2-flash": { n: "MiMo V2 Flash", i: 0.09, o: 0.29, cr: 0.009, cc: 0 },
  "mimo-v2-pro": { n: "MiMo V2 Pro", i: 0.435, o: 0.87, cr: 0.0036, cc: 0 }, "mimo-v2.5": { n: "MiMo-V2.5", i: 0.14, o: 0.28, cr: 0.0028, cc: 0 },
  "mimo-v2.5-pro": { n: "MiMo-V2.5-Pro", i: 0.435, o: 0.87, cr: 0.0036, cc: 0 }, "mimo-v2.5-pro-ultraspeed": { n: "MiMo-V2.5-Pro-UltraSpeed", i: 1.305, o: 2.61, cr: 0.0108, cc: 0 },
  "mimo-v2.6-flash": { n: "MiMo-V2.6-Flash", i: 0.14, o: 0.28, cr: 0.0028, cc: 0 }, "mimo-v2.6-pro": { n: "MiMo-V2.6-Pro", i: 0.435, o: 0.87, cr: 0.0036, cc: 0 },
  "mimo-v2.6-pro-ultraspeed": { n: "MiMo-V2.6-Pro-UltraSpeed", i: 4.35, o: 8.7, cr: 0.036, cc: 0 }, "minimax-m2": { n: "MiniMax M2", i: 0.3, o: 1.2, cr: 0.03, cc: 0.375 },
  "minimax-m2.1": { n: "MiniMax-M2.1", i: 0.3, o: 1.2, cr: 0.03, cc: 0.375 }, "minimax-m2.1-lightning": { n: "MiniMax M2.1 Lightning", i: 0.27, o: 2.33, cr: 0.03, cc: 0 },
  "minimax-m2.5": { n: "MiniMax-M2.5", i: 0.3, o: 1.2, cr: 0.03, cc: 0.375 }, "minimax-m2.5-highspeed": { n: "MiniMax-M2.5-highspeed", i: 0.6, o: 2.4, cr: 0.06, cc: 0.375 },
  "minimax-m2.5-lightning": { n: "MiniMax M2.5 Lightning", i: 0.3, o: 2.4, cr: 0.03, cc: 0 }, "minimax-m2.7": { n: "MiniMax-M2.7", i: 0.3, o: 1.2, cr: 0.06, cc: 0.375 },
  "minimax-m2.7-highspeed": { n: "MiniMax-M2.7-highspeed", i: 0.6, o: 2.4, cr: 0.06, cc: 0.375 }, "minimax-m3": { n: "MiniMax-M3", i: 0.3, o: 1.2, cr: 0.06, cc: 0 },
  "mistral-large-3-2512": { n: "Mistral Large 3", i: 0.5, o: 1.5, cr: 0.05, cc: 0 }, "mistral-medium-3.1": { n: "Mistral Medium 3.1", i: 0.4, o: 2, cr: 0.04, cc: 0 },
  "mistral-medium-3.5": { n: "Mistral Medium 3.5", i: 1.5, o: 7.5, cr: 0, cc: 0 }, "mistral-small-3.2-24b": { n: "Mistral Small 3.2", i: 0.075, o: 0.2, cr: 0.01, cc: 0 },
  "mistral-small-4": { n: "Mistral Small 4", i: 0.1, o: 0.3, cr: 0.01, cc: 0 }, "o1": { n: "OpenAI o1", i: 15, o: 60, cr: 7.5, cc: 0 },
  "o1-mini": { n: "OpenAI o1-mini", i: 0.55, o: 2.2, cr: 0.55, cc: 0 }, "o3": { n: "OpenAI o3", i: 2, o: 8, cr: 0.5, cc: 0 },
  "o3-mini": { n: "OpenAI o3-mini", i: 0.55, o: 2.2, cr: 0.55, cc: 0 }, "o3-pro": { n: "OpenAI o3-pro", i: 20, o: 80, cr: 0, cc: 0 },
  "o4-mini": { n: "OpenAI o4-mini", i: 1.1, o: 4.4, cr: 0.275, cc: 0 }, "qwen3-235b-a22b": { n: "Qwen3 235B-A22B", i: 0.7, o: 8.4, cr: 0, cc: 0 },
  "qwen3-32b": { n: "Qwen3 32B", i: 0.16, o: 0.64, cr: 0, cc: 0 }, "qwen3-coder-480b": { n: "Qwen3 Coder 480B", i: 0.65, o: 3.25, cr: 0, cc: 0 },
  "qwen3-coder-480b-a35b-instruct": { n: "Qwen3 Coder 480B-A35B Instruct", i: 0.65, o: 3.25, cr: 0, cc: 0 }, "qwen3-coder-flash": { n: "Qwen3 Coder Flash", i: 0.195, o: 0.975, cr: 0.039, cc: 0 },
  "qwen3-coder-next": { n: "Qwen3 Coder Next", i: 0.12, o: 0.75, cr: 0, cc: 0 }, "qwen3-coder-plus": { n: "Qwen3 Coder Plus", i: 0.65, o: 3.25, cr: 0.13, cc: 0 },
  "qwen3-max": { n: "Qwen3 Max", i: 0.78, o: 3.9, cr: 0, cc: 0 }, "qwen3.5-plus": { n: "Qwen3.5 Plus", i: 0.26, o: 1.56, cr: 0.052, cc: 0 },
  "qwen3.6-27b": { n: "Qwen3.6 27B", i: 0.6, o: 3.6, cr: 0, cc: 0 }, "qwen3.6-flash": { n: "Qwen3.6 Flash", i: 0.1875, o: 1.125, cr: 0, cc: 0.234375 },
  "qwen3.6-plus": { n: "Qwen3.6 Plus", i: 0.325, o: 1.95, cr: 0.065, cc: 0 }, "qwen3.7-max": { n: "Qwen3.7 Max", i: 2.5, o: 7.5, cr: 0.5, cc: 3.125 },
  "qwen3.7-plus": { n: "Qwen3.7 Plus", i: 0.5, o: 3, cr: 0.05, cc: 0.625 }, "qwen3.8-2.4t-a95b": { n: "Qwen3.8 2.4T A95B", i: 2, o: 6, cr: 0.25, cc: 2.5 },
  "qwen3.8-27b": { n: "Qwen3.8 27B", i: 0.5, o: 3, cr: 0.1, cc: 0.625 }, "qwen3.8-flash": { n: "Qwen3.8 Flash", i: 0.15, o: 0.47, cr: 0.016, cc: 0.2 },
  "qwen3.8-max": { n: "Qwen3.8 Max", i: 2, o: 6, cr: 0.25, cc: 2.5 }, "qwq-32b": { n: "QwQ 32B", i: 0.2, o: 0.6, cr: 0, cc: 0 },
  "qwq-plus": { n: "QwQ Plus", i: 0.8, o: 2.4, cr: 0, cc: 0 }, "step-3.5-flash": { n: "Step 3.5 Flash", i: 0.1, o: 0.3, cr: 0.02, cc: 0 },
  "step-3.5-flash-2603": { n: "Step 3.5 Flash 2603", i: 0.1, o: 0.3, cr: 0.02, cc: 0 }, "step-3.7-flash": { n: "Step 3.7 Flash", i: 0.19, o: 1.13, cr: 0.04, cc: 0 },
};

// 定价查找：依次尝试 精确 → 去掉 provider 前缀（vendor/model）→ 去掉日期后缀。
// 找不到就返回 null，由调用方决定「不计费」而不是拿 0 冒充。
function lookupPricing(table, ...candidates) {
  for (const raw of candidates) {
    const key = String(raw || '').trim();
    if (!key) continue;
    const tries = [key];
    const slash = key.lastIndexOf('/');
    if (slash >= 0) tries.push(key.slice(slash + 1));           // deepseek/deepseek-v4.1-flash → deepseek-v4.1-flash
    for (const t of tries.slice()) {
      const stripped = t.replace(/-\d{8}$/, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');  // 去日期后缀
      if (stripped !== t) tries.push(stripped);
    }
    for (const t of tries) {
      if (table[t]) return { key: t, ...table[t] };
    }
  }
  return null;
}

// 用定价表估算一次请求的花费（美元）。token 为 Anthropic 口径。
function estimateCost(table, model, tok) {
  const p = lookupPricing(table, tok.pricingModel, tok.canonical, model);
  if (!p) return null;
  const M = 1e6;
  const cost =
    (tok.input / M) * p.i +
    (tok.output / M) * p.o +
    (tok.cacheRead / M) * p.cr +
    (tok.cacheCreation / M) * p.cc;
  return { cost, pricingKey: p.key, estimated: true };
}

// ---------- 从上游 usage 提取 token（OpenAI 口径 → Anthropic 口径）----------
// 上游返回的真实成本在 usage.cost / usage.gateway_cost（实测字段），
// 有就直接用 —— 那是网关自己的账单，比任何定价表都准。
export function normalizeUpstreamUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = Number(usage.prompt_tokens) || 0;
  const cached = Number(usage.prompt_tokens_details?.cached_tokens) || 0;
  const completion = Number(usage.completion_tokens) || 0;
  const creation = Number(usage.cache_creation_input_tokens) || 0;
  // OpenAI 的 prompt_tokens 含缓存；Anthropic 口径要求 input 是不含缓存的部分
  const input = Math.max(0, prompt - cached - creation);
  const real = Number(usage.cost ?? usage.gateway_cost);
  return {
    input,
    output: completion,
    cacheRead: cached,
    cacheCreation: creation,
    total: prompt + completion,
    reasoning: Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
    realCost: Number.isFinite(real) ? real : null,
  };
}

// ---------- 日期分桶 ----------
// 用本地时区切天：用户看到的「今天」是他自己的今天，不是 UTC 的。
export function dayKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ---------- 存储 ----------
// 一个 store 管三样东西：
//   usage.jsonl      逐条明细（append-only）
//   usage_daily.json 按天×账号×渠道×模型 的汇总（小，读得快）
//   usage_sync.json  会话扫描的增量游标
export function createUsageStore(dir, { pricing = {}, maxDetailLines = 200000 } = {}) {
  // 目录可能还不存在（首次运行、或调用方给了新的子目录）—— 先建好，
  // 否则第一次 appendFileSync 直接 ENOENT 崩掉。
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或不可写，交给后续写入报错 */ }
  const DETAIL = path.join(dir, 'usage.jsonl');
  const DAILY = path.join(dir, 'usage_daily.json');
  const SYNC = path.join(dir, 'usage_sync.json');
  const PRICING = path.join(dir, 'pricing.json');

  // 用户自定义定价覆盖内置表（同名以用户为准）
  const customPricing = fs.existsSync(PRICING)
    ? (() => { try { return JSON.parse(fs.readFileSync(PRICING, 'utf8')); } catch { return {}; } })()
    : {};
  const table = { ...BUILTIN_PRICING, ...pricing, ...customPricing };

  let daily = null;       // { "YYYY-MM-DD": { rollups: { key: {...} } } }
  let syncState = null;   // { files: { "path": { offset, mtime, size } } }
  let detailLines = 0;    // 明细行数，用于触发压缩
  const seenIds = new Set();  // 已记录的请求 id（去重用），启动时从明细回填

  function loadDaily() {
    if (daily) return daily;
    try { daily = JSON.parse(fs.readFileSync(DAILY, 'utf8')); } catch { daily = {}; }
    return daily;
  }
  function loadSync() {
    if (syncState) return syncState;
    try { syncState = JSON.parse(fs.readFileSync(SYNC, 'utf8')); } catch { syncState = { files: {} }; }
    if (!syncState.files) syncState.files = {};
    return syncState;
  }
  const saveSync = () => fs.writeFileSync(SYNC, JSON.stringify(syncState));

  // 汇总键：同一天里按 账号 / 渠道 / 请求模型 / 真实模型 分桶
  const rollupKey = (e) => [e.account || '-', e.provider || '-', e.model || '-', e.canonical || '-'].join(' ');

  function bumpDaily(entry) {
    const d = loadDaily();
    const day = dayKey(entry.ts);
    const bucket = (d[day] ||= { rollups: {} });
    const k = rollupKey(entry);
    const r = (bucket.rollups[k] ||= {
      account: entry.account || null, provider: entry.provider || null,
      model: entry.model || null, canonical: entry.canonical || null,
      requestModel: entry.requestModel || null,
      requests: 0, success: 0,
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      cost: 0, costReal: 0, costEstimated: 0,
      msSum: 0, msCount: 0, firstTokenSum: 0, firstTokenCount: 0,
      bySource: {},
    });
    r.requests += 1;
    if (!entry.error) r.success += 1;
    for (const f of ['input', 'output', 'cacheRead', 'cacheCreation']) r[f] += Number(entry[f]) || 0;
    if (entry.cost != null) {
      r.cost += entry.cost;
      if (entry.costSource === 'real') r.costReal += entry.cost;
      else r.costEstimated += entry.cost;
    }
    if (Number(entry.ms) > 0) { r.msSum += Number(entry.ms); r.msCount += 1; }
    if (Number(entry.firstTokenMs) > 0) { r.firstTokenSum += Number(entry.firstTokenMs); r.firstTokenCount += 1; }
    r.bySource[entry.source] = (r.bySource[entry.source] || 0) + 1;
    return d;
  }

  // 记一条。返回 false 表示这条被去重跳过了。
  function add(entry) {
    const id = entry.id ? String(entry.id) : null;
    if (id && seenIds.has(id)) return false;
    if (id) seenIds.add(id);
    const line = JSON.stringify(entry);
    fs.appendFileSync(DETAIL, line + '\n');
    detailLines += 1;
    fs.writeFileSync(DAILY, JSON.stringify(bumpDaily(entry)));
    return true;
  }

  // 批量记（会话扫描用）：只写一次汇总文件，避免逐条重写。
  function addMany(entries) {
    const fresh = [];
    for (const e of entries) {
      const id = e.id ? String(e.id) : null;
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      fresh.push(e);
    }
    if (!fresh.length) return 0;
    fs.appendFileSync(DETAIL, fresh.map((e) => JSON.stringify(e)).join('\n') + '\n');
    detailLines += fresh.length;
    let d = null;
    for (const e of fresh) d = bumpDaily(e);
    if (d) fs.writeFileSync(DAILY, JSON.stringify(d));
    return fresh.length;
  }

  // 启动时回填：明细里的 id 集合 + 行数。只读尾部若干行，
  // 避免历史很长时启动变慢（去重只需要认出「近期」重复，会话扫描本身也是增量）。
  function prime({ tailLines = 20000 } = {}) {
    if (!fs.existsSync(DETAIL)) return { lines: 0 };
    const raw = fs.readFileSync(DETAIL, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    detailLines = lines.length;
    const tail = lines.slice(-tailLines);
    for (const l of tail) {
      try {
        const o = JSON.parse(l);
        if (o && o.id) seenIds.add(String(o.id));
      } catch { /* 忽略坏行 */ }
    }
    return { lines: lines.length, ids: seenIds.size };
  }

  // 明细文件过大时按天裁剪：保留最近 keepDays 天，重写文件。
  function compact({ keepDays = 90 } = {}) {
    if (!fs.existsSync(DETAIL)) return { removed: 0 };
    const cutoff = Date.now() - keepDays * 86400e3;
    const lines = fs.readFileSync(DETAIL, 'utf8').split('\n').filter(Boolean);
    const kept = [];
    let removed = 0;
    for (const l of lines) {
      let o = null;
      try { o = JSON.parse(l); } catch { removed += 1; continue; }
      if (Number(o.ts) >= cutoff) kept.push(l);
      else removed += 1;
    }
    if (removed) {
      const tmp = DETAIL + '.tmp';
      fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
      fs.renameSync(tmp, DETAIL);
      detailLines = kept.length;
    }
    return { removed, kept: kept.length };
  }

  return {
    add, addMany, prime, compact, table,
    get daily() { return loadDaily(); },
    get sync() { return loadSync(); },
    saveSync,
    get lines() { return detailLines; },
    has: (id) => seenIds.has(String(id)),
    paths: { DETAIL, DAILY, SYNC, PRICING },
    estimateCost: (model, tok) => estimateCost(table, model, tok),
    lookupPricing: (...c) => lookupPricing(table, ...c),
  };
}

// ---------- 会话记录扫描 ----------
// Claude Code 把每个会话写成 ~/.claude/projects/<项目目录>/<会话 id>.jsonl，
// 里面的 assistant 记录带 message.usage 与 message.id（gen_* / msg_*）。
// 我们按文件做增量：只读上次偏移之后的新字节，所以反复扫描很快。
//
// 去重的依据是 message.id —— 实测走代理的请求（request_id 形如 session:gen_xxx）
// 与会话里同一条记录的 message.id 是同一个值，所以能可靠地对上。
export function scanClaudeSessions({ projectsDir, sync, store, sinceDays = 30 } = {}) {
  const out = { files: 0, scanned: 0, added: 0, skipped: 0, errors: [] };
  if (!projectsDir || !fs.existsSync(projectsDir)) return out;

  const cutoff = sinceDays > 0 ? Date.now() - sinceDays * 86400e3 : 0;
  let projects = [];
  try { projects = fs.readdirSync(projectsDir); } catch (e) { out.errors.push(e.message); return out; }

  for (const proj of projects) {
    const pdir = path.join(projectsDir, proj);
    let st = null;
    try { st = fs.statSync(pdir); } catch { continue; }
    if (!st.isDirectory()) continue;

    let files = [];
    try { files = fs.readdirSync(pdir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(pdir, f);
      let fst = null;
      try { fst = fs.statSync(full); } catch { continue; }
      if (cutoff && fst.mtimeMs < cutoff) continue;

      const prev = sync.files[full];
      // 文件变小说明被重写/截断了 —— 从头重扫
      let offset = prev && prev.size === fst.size ? prev.offset : 0;
      if (prev && fst.size < prev.offset) offset = 0;
      if (offset >= fst.size) continue;

      out.files += 1;
      let text = '';
      try {
        const fd = fs.openSync(full, 'r');
        const len = fst.size - offset;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        fs.closeSync(fd);
        text = buf.toString('utf8');
      } catch (e) { out.errors.push(f + ': ' + e.message); continue; }

      // 末行可能不完整（正在写入）：保留到最后换行符为止，下次从那里续读
      const lastNl = text.lastIndexOf('\n');
      const usable = lastNl >= 0 ? text.slice(0, lastNl + 1) : '';
      const newOffset = offset + Buffer.byteLength(usable, 'utf8');
      sync.files[full] = { offset: newOffset, size: fst.size, mtime: fst.mtimeMs };

      const batch = [];
      for (const line of usable.split('\n')) {
        if (!line.trim()) continue;
        let o = null;
        try { o = JSON.parse(line); } catch { continue; }
        out.scanned += 1;
        const msg = o.message;
        const usage = msg && msg.usage;
        if (!usage || o.type !== 'assistant') continue;
        const id = msg.id;
        if (!id) continue;
        // synthetic 记录（本地生成、没走模型）没有 token，跳过
        const input = Number(usage.input_tokens) || 0;
        const output = Number(usage.output_tokens) || 0;
        const cacheRead = Number(usage.cache_read_input_tokens) || 0;
        const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
        if (!input && !output && !cacheRead && !cacheCreation) continue;
        if (store.has(id)) { out.skipped += 1; continue; }
        const ts = Date.parse(o.timestamp) || fst.mtimeMs;
        const model = msg.model || null;
        // 会话记录里没有成本信息，只有 token。但我们有定价表 ——
        // 用估算填上，并标记 costSource: 'estimated'，让前端能与
        // 「上游真实账单」区分开。不填的话用户会看到 $0 以为免费。
        const est = store.estimateCost(model, { input, output, cacheRead, cacheCreation });
        batch.push({
          id, ts, source: 'session',
          model,
          canonical: model,
          provider: null,
          account: null,
          requestModel: model,
          input, output, cacheRead, cacheCreation,
          total: input + output + cacheRead + cacheCreation,
          cost: est ? est.cost : null,
          costSource: est ? 'estimated' : null,
          sessionId: o.sessionId || null,
          cwd: o.cwd || null,
          gitBranch: o.gitBranch || null,
          error: null,
        });
      }
      const added = store.addMany(batch);
      out.added += added;
      out.skipped += batch.length - added;
    }
  }
  store.saveSync();
  return out;
}
