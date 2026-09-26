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
import { deepseekCostCny } from './pricing-cny.js';

// ---------- 币种 ----------
// 这里有两套彼此独立的钱，**绝不能混成一个总额**：
//   1. 美元（cost）：经代理的请求带上游网关的真实账单（costSource='real'），
//      或非 DeepSeek 模型按 models.dev 定价表的估算（'estimated'）。
//   2. 人民币（costCny）：DeepSeek 官方价目表算出来的，与渠道无关、只按 token 和时段算。
//      同一笔 DeepSeek 请求会同时有两个数：上游账单是多少美元，按官网价是多少人民币。
//      这不是重复计算，是两个问题的答案，各自小计、各自标注币种。
export const USD = 'USD';
export const CNY = 'CNY';

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
  const t = tok || {};
  const p = lookupPricing(table, t.pricingModel, t.canonical, model);
  if (!p) return null;
  const M = 1e6;
  // 与 pricing-cny 口径一致：负数与非有限值一律当 0。
  // `Number(-5) || 0` 会保留 -5，算出负费用去抵消别的记录，把总额算少。
  const n = (v) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x : 0; };
  const cost =
    (n(t.input) / M) * p.i +
    (n(t.output) / M) * p.o +
    (n(t.cacheRead) / M) * p.cr +
    (n(t.cacheCreation) / M) * p.cc;
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

// 小时桶键，形如 2026-09-26T14。用**本地**时区，和 dayKey 保持一致 ——
// 「今天」这一档要按小时画图，若小时用 UTC 而天用本地，跨时区时会出现
// 「今天的某个小时被算到昨天」这种对不上的情况。
export function hourKey(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

// ---------- 存储 ----------
// 一个 store 管四样东西：
//   usage.jsonl       逐条明细（append-only）
//   usage_daily.json  按天×账号×渠道×模型 的汇总（小，读得快）
//   usage_hourly.json 按小时×账号×渠道×模型 的汇总（供「当天」这一档画小时曲线）
//   usage_sync.json   会话扫描的增量游标
export function createUsageStore(dir, { pricing = {}, maxDetailLines = 200000 } = {}) {
  // 目录可能还不存在（首次运行、或调用方给了新的子目录）—— 先建好，
  // 否则第一次 appendFileSync 直接 ENOENT 崩掉。
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在或不可写，交给后续写入报错 */ }
  const DETAIL = path.join(dir, 'usage.jsonl');
  const DAILY = path.join(dir, 'usage_daily.json');
  const HOURLY = path.join(dir, 'usage_hourly.json');
  const SYNC = path.join(dir, 'usage_sync.json');
  const PRICING = path.join(dir, 'pricing.json');

  // 用户自定义定价覆盖内置表（同名以用户为准）
  const customPricing = fs.existsSync(PRICING)
    ? (() => { try { return JSON.parse(fs.readFileSync(PRICING, 'utf8')); } catch { return {}; } })()
    : {};
  const table = { ...BUILTIN_PRICING, ...pricing, ...customPricing };

  let daily = null;       // { "YYYY-MM-DD": { rollups: { key: {...} } } }
  let hourly = null;      // { "YYYY-MM-DDTHH": { rollups: { key: {...} } } }
  let syncState = null;   // { files: { "path": { offset, mtime, size } } }
  let detailLines = 0;    // 明细行数，用于触发压缩
  let seq = 0;            // 单调递增的写入序号，见 add() 里的说明
  const seenIds = new Set();  // 已记录的请求 id（去重用），启动时从明细回填

  function loadDaily() {
    if (daily) return daily;
    try { daily = JSON.parse(fs.readFileSync(DAILY, 'utf8')); } catch { daily = {}; }
    return daily;
  }
  function loadHourly() {
    if (hourly) return hourly;
    try { hourly = JSON.parse(fs.readFileSync(HOURLY, 'utf8')); } catch { hourly = {}; }
    return hourly;
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

  // 往一个桶里累加一条记录。daily 与 hourly 共用这一段 ——
  // 两处各写一遍累加逻辑的话，迟早会有某个字段只加进了其中一边，
  // 而那种错在界面上表现为「两个图对不上」，很难定位。
  function bumpInto(bucketMap, keyName, entry) {
    const bucket = (bucketMap[keyName] ||= { rollups: {} });
    const k = rollupKey(entry);
    const r = (bucket.rollups[k] ||= {
      account: entry.account || null, provider: entry.provider || null,
      model: entry.model || null, canonical: entry.canonical || null,
      requestModel: entry.requestModel || null,
      requests: 0, success: 0,
      input: 0, output: 0, cacheRead: 0, cacheCreation: 0,
      cost: 0, costReal: 0, costEstimated: 0,
      costCny: 0, costCnyPeak: 0,
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
    // 人民币只有 DeepSeek 系列算得出来（认不出的模型是 null，不进这里）。
    // 单独累计、单独小计 —— 和上面的美元不是一回事，不能相加。
    if (entry.costCny != null) {
      r.costCny += entry.costCny;
      if (entry.costCnyPeak) r.costCnyPeak += entry.costCny;
    }
    if (Number(entry.ms) > 0) { r.msSum += Number(entry.ms); r.msCount += 1; }
    if (Number(entry.firstTokenMs) > 0) { r.firstTokenSum += Number(entry.firstTokenMs); r.firstTokenCount += 1; }
    r.bySource[entry.source] = (r.bySource[entry.source] || 0) + 1;
    return bucketMap;
  }

  function bumpDaily(entry) { return bumpInto(loadDaily(), dayKey(entry.ts), entry); }

  function bumpHourly(entry) {
    const h = loadHourly();
    const out = bumpInto(h, hourKey(entry.ts), entry);
    // 小时桶只服务于「当天按小时」这一档，攒多了没意义还会让文件变大。
    // 保留最近 4 天（当天最坏也就跨零点那几个小时）。
    const keys = Object.keys(h).sort();
    if (keys.length > 4 * 24) for (const k of keys.slice(0, keys.length - 4 * 24)) delete h[k];
    return out;
  }

  // 记一条。返回 false 表示这条被去重跳过了。
  //
  // 每条都带一个自增的 `n`（写入序号）。为什么需要它：会话扫描是**按文件顺序**追加的，
  // 而文件顺序不等于时间顺序（实测 1701 条里有 57 条乱序）。明细接口若只把文件尾部
  // 当成「最近 N 条」，就会漏掉真正最新的记录、又混进旧的 —— 这正是「倒序」要修的问题。
  // 有了 n 就能按「写入先后」倒序取，和从尾部读的做法天然一致。
  // 追加前先确认文件以换行结尾。若上一条记录写了一半就崩了（末行没有换行），
  // 直接 append 会把新记录**粘在那半行后面**，两行合起来永远解析不了 ——
  // 那条新请求明明已经计费、也进了汇总、还触发了实时推送，却从明细里彻底消失。
  // 补一个换行就把粘连切断：坏行还是坏行（会被跳过），新记录是完整的一行。
  function appendLines(text) {
    let prefix = '';
    try {
      const st = fs.statSync(DETAIL);
      if (st.size > 0) {
        const fd = fs.openSync(DETAIL, 'r');
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, st.size - 1);
        fs.closeSync(fd);
        if (buf[0] !== 0x0a) prefix = '\n';
      }
    } catch { /* 文件不存在或读不了：当作空文件，不补前缀 */ }
    fs.appendFileSync(DETAIL, prefix + text);
  }

  function add(entry) {
    const id = entry.id ? String(entry.id) : null;
    if (id && seenIds.has(id)) return false;
    if (id) seenIds.add(id);
    appendLines(JSON.stringify({ ...entry, n: ++seq }) + '\n');
    detailLines += 1;
    fs.writeFileSync(DAILY, JSON.stringify(bumpDaily(entry)));
    fs.writeFileSync(HOURLY, JSON.stringify(bumpHourly(entry)));
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
    appendLines(fresh.map((e) => JSON.stringify({ ...e, n: ++seq })).join('\n') + '\n');
    detailLines += fresh.length;
    let d = null; let h = null;
    for (const e of fresh) { d = bumpDaily(e); h = bumpHourly(e); }
    if (d) fs.writeFileSync(DAILY, JSON.stringify(d));
    if (h) fs.writeFileSync(HOURLY, JSON.stringify(h));
    return fresh.length;
  }

  // 启动时回填：明细里的 id 集合 + 行数 + 最大写入序号。只读尾部若干行做去重，
  // 但序号要从**全部**行里取最大值 —— 尾部窗口之外的老记录也可能带着更大的 n
  // （乱序追加的历史），拿尾部的最大值会让新记录与老记录重号。
  function prime({ tailLines = 20000 } = {}) {
    if (!fs.existsSync(DETAIL)) return { lines: 0 };
    const raw = fs.readFileSync(DETAIL, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    detailLines = lines.length;
    for (const l of lines) {
      const i = l.lastIndexOf('"n":');
      if (i < 0) continue;
      const v = Number(l.slice(i + 4).split(/[,}]/)[0]);
      if (Number.isFinite(v) && v > seq) seq = v;
    }
    for (const l of lines.slice(-tailLines)) {
      try {
        const o = JSON.parse(l);
        if (o && o.id) seenIds.add(String(o.id));
      } catch { /* 忽略坏行 */ }
    }
    return { lines: lines.length, ids: seenIds.size, seq };
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

  // 重算所有汇总（按天 + 按小时）与**逐条明细的人民币字段**。
  //
  // 为什么需要它：人民币计价是后加的能力，之前的记录里根本没有 costCny 字段，
  // 而汇总文件（usage_daily.json / usage_hourly.json）只在**写入时**累加。
  // 于是不重算的话，历史数据在界面上永远是 ¥0，新数据却有值 ——
  // 同一个界面里一半有数一半是 0，比「都没数」更容易让人判断错。
  //
  // 同时把每条明细的 costCny / costCnyPeak 补写回去：这样单条记录的花费
  // 与汇总口径一致，不会出现「明细说 ¥0.01、当天合计说 ¥0」的矛盾。
  //
  // 幂等：重算只按**差值**调整汇总（新算出的 costCny 减去这条已经累计过的），
  // 跑几次结果都一样，不会叠加。
  //
  // 为什么不「从明细重建汇总」（第一版就是这么写的，是个真 bug）：
  // 汇总**刻意**比明细活得久 —— `compact()` 删掉 90 天前的明细时，
  // 按天汇总必须保留（界面上写着「按天汇总与总计不受影响」）。
  // 所以拿明细重建汇总，等于把 compact 删掉的那些历史一并抹掉：
  // 一年历史会缩成 90 天，而且不可恢复（明细已经没了）。
  // 走差值就只碰「每条自己那部分」，没明细的桶原样不动。
  function recompute({ withDetail = true } = {}) {
    if (!fs.existsSync(DETAIL)) return { records: 0, days: 0, hours: 0, cny: 0, changed: 0 };
    const raw = fs.readFileSync(DETAIL, 'utf8');
    const lines = raw.split('\n');
    const d = loadDaily();
    const h = loadHourly();
    // 汇总是不是「根本没有」。
    // 只有在**完全没有汇总**时才允许按整条重建（新装的库、汇总文件被删）。
    // 一旦汇总非空，就只能走差值 —— 因为汇总里可能含有明细已经被 compact 掉的
    // 历史，那不是「缺失」而是「刻意保留」；反过来按明细重建会与它重复计数。
    // 这两种状态从外面看长得一样（都是「这条记录在汇总里找不到对应分桶」），
    // 所以只能靠「汇总整体是否为空」来区分。
    const hasSummary = Object.keys(d).length > 0 || Object.keys(h).length > 0;
    const rewritten = [];
    let count = 0;       // 能解析的记录数
    let kept = 0;        // 原样保留的行数（含坏行）—— 明细行数要按它算
    let changed = 0;

    for (const l of lines) {
      if (!l) continue;
      let o = null;
      try { o = JSON.parse(l); } catch { rewritten.push(l); kept += 1; continue; }
      count += 1;
      kept += 1;
      // 重算这条的人民币（认不出的模型得 null，保持 null）
      const cny = deepseekCostCny(o.model, {
        input: o.input, output: o.output, cacheRead: o.cacheRead,
        cacheCreation: o.cacheCreation, canonical: o.canonical, pricingModel: o.requestModel,
      }, o.ts);
      const val = cny ? cny.cost : null;
      const peak = cny ? cny.peak : null;
      const had = Number(o.costCny) || 0;          // 这条此前已经累计进汇总的金额
      const hadPeak = o.costCnyPeak === true;      // 此前它算不算「高峰那一部分」
      const nowPeak = cny ? !!cny.peak : false;
      if (o.costCny !== val || o.costCnyPeak !== peak) {
        o.costCny = val;
        o.costCnyPeak = peak;
        changed += 1;
      }
      // 序号缺失的老记录补上（倒序读取依赖 n）
      if (typeof o.n !== 'number') { o.n = seq + 1; seq += 1; changed += 1; }
      if (o.n > seq) seq = o.n;

      // 同步这条记录对汇总的贡献。两种情况要分开处理，缺一不可：
      //   - 桶里已经有这条记录 → 只按**差值**调整人民币（其余字段已经计过，不能重复计）
      //   - 桶里没有（汇总整个丢了、或这条从没进过汇总）→ 按整条重建
      // 只做差值的话，汇总为空的库（新装、或汇总文件被删）永远建不起来；
      // 只做重建的话，compact 删掉明细的那些历史会被抹掉。两个方向都得覆盖。
      const delta = (val || 0) - had;
      const deltaPeak = (nowPeak ? (val || 0) : 0) - (hadPeak ? had : 0);
      syncCnyBucket(d, dayKey(o.ts), o, delta, deltaPeak, hasSummary);
      syncCnyBucket(h, hourKey(o.ts), o, delta, deltaPeak, hasSummary);
      rewritten.push(withDetail ? JSON.stringify(o) : l);
    }

    // 小时桶仍按「最近 4 天」裁剪：重建路径可能把很久以前的小时又加回来
    const hk2 = Object.keys(h).sort();
    if (hk2.length > 4 * 24) for (const k of hk2.slice(0, hk2.length - 4 * 24)) delete h[k];

    // 顺序很重要：先把汇总落盘、**再**动明细文件。
    // 反过来的话，若在两步之间进程被杀，磁盘上就是「新汇总 + 有坏行的旧明细」对不上
    // 的状态；按这个顺序最多重算没生效，下次再点一次即可（幂等）。
    fs.writeFileSync(DAILY, JSON.stringify(d));
    fs.writeFileSync(HOURLY, JSON.stringify(h));
    if (withDetail && changed) {
      const tmp = DETAIL + '.tmp';
      // 结尾补换行：末行若没有换行（写入中崩溃留下的半行），
      // 下一条 append 会**粘在它后面**，两行一起变成永远解析不了的坏行 —— 那条记录
      // 明明已经被计费、也进了汇总，却从明细里消失。补上换行就切断了这种粘连。
      fs.writeFileSync(tmp, rewritten.join('\n') + '\n');
      fs.renameSync(tmp, DETAIL);
    }
    // 行数按「实际保留的行数」算，不是「能解析的条数」——
    // 否则界面上「引擎保留 N 条」会与应用列出的条数对不上。
    detailLines = kept;
    // 报告的人民币总额取自**汇总**，不是「明细逐条相加」——
    // 汇总里还留着明细已被 compact 掉的历史，两者本就不该相等；
    // 拿明细之和去报会少报，界面上会和卡片里的合计对不上。
    let cnyTotal = 0;
    for (const day of Object.values(d)) {
      for (const r of Object.values(day.rollups || {})) cnyTotal += Number(r.costCny) || 0;
    }
    return { records: count, kept, changed, days: Object.keys(d).length, hours: Object.keys(h).length, cny: cnyTotal };
  }

  // 把一条记录同步进某个桶。
  //
  // hasSummary=false（汇总整体为空）→ 按整条重建：新装的库、汇总文件被删的情况，
  //   不重建就永远没有汇总。
  // hasSummary=true → 只调人民币差值。**绝不按整条重建**：汇总里可能含有明细已被
  //   compact 掉的同一批记录（compact 刻意保留汇总），按明细重建会与它重复计数，
  //   请求数、token、金额全部翻倍。
  function syncCnyBucket(bucketMap, keyName, entry, delta, deltaPeak, hasSummary) {
    if (!hasSummary) {
      bumpInto(bucketMap, keyName, entry);
      return;
    }
    const bucket = bucketMap[keyName];
    // 这条记录所属的日期/小时整个不在汇总里：它要么是明细被 compact 掉的老记录，
    // 要么是时间上晚于快照时间戳的那一条。无论哪种，按整条加进去都是对的 ——
    // 因为汇总里根本没有它那个桶，不存在重复计数的对象。
    if (!bucket) {
      bumpInto(bucketMap, keyName, entry);
      return;
    }
    const r = bucket.rollups[rollupKey(entry)];
    if (!r) {
      // 桶在、但缺这个分桶。上面两种歧义在这里都可能：为了不重复计数，
      // 宁可少建也不能凭空把整条加进去（少建的分桶只是钱少算，重复计会把总数算翻倍）。
      return;
    }
    if (delta !== 0 || deltaPeak !== 0) {
      r.costCny = (Number(r.costCny) || 0) + delta;
      r.costCnyPeak = (Number(r.costCnyPeak) || 0) + deltaPeak;
    }
  }

  // 按写入序号倒序读明细：从文件尾部往前扫，天然就是「最新的在前」。
  // 这样接口不必把整个文件读进内存，也不会把「文件位置」误当成「时间顺序」。
  //
  // 返回 truncated 表示「扫到上限就停了，结果可能不完整」。
  // 这一点必须如实上报：之前只在「没凑够 limit」时报 truncated，于是**带筛选且
  // 匹配项正好都在更老的位置**时，会带着 truncated=false 返回「没有匹配」——
  // 一个看起来正常的空结果，实际是没扫到。空结果和「扫不完」是两回事，不能混。
  function recentRecords({ limit = 200, model = '', source = '', from = 0, to = 0 } = {}) {
    const out = [];
    if (!fs.existsSync(DETAIL)) return { records: out, detailLines, truncated: false };
    const lines = fs.readFileSync(DETAIL, 'utf8').split('\n');
    // limit 是「要几条」，但带筛选时可能翻很久，给个扫描上限防止极端情况卡住。
    const maxScan = Math.max(limit * 20, 5000);
    let scanned = 0;
    let capped = false;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (out.length >= limit) break;
      if (scanned >= maxScan) { capped = true; break; }
      const l = lines[i];
      scanned += 1;
      if (!l) continue;
      let o = null;
      try { o = JSON.parse(l); } catch { continue; }
      if (model && !String(o.model || '').includes(model)) continue;
      if (source && o.source !== source) continue;
      if (from && Number(o.ts) < from) continue;
      if (to && Number(o.ts) > to) continue;
      out.push(o);
    }
    return { records: out, detailLines, truncated: capped, scanned };
  }

  return {
    add, addMany, prime, compact, recompute, recentRecords, table,
    get daily() { return loadDaily(); },
    get hourly() { return loadHourly(); },
    get sync() { return loadSync(); },
    saveSync,
    get lines() { return detailLines; },
    has: (id) => seenIds.has(String(id)),
    paths: { DETAIL, DAILY, HOURLY, SYNC, PRICING },
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
        // 人民币：DeepSeek 系列走官方价目表（含峰谷时段）。k3/glm 之类认不出，
        // 保持 null 而不是 0 —— 界面上「没有人民币价」和「花了 0 元」必须区分开。
        const cny = deepseekCostCny(model, { input, output, cacheRead, cacheCreation, canonical: model }, ts);
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
          costCny: cny ? cny.cost : null,
          costCnyPeak: cny ? cny.peak : null,
          cnyPricingKey: cny ? cny.pricingKey : null,
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
