#!/usr/bin/env bash
# 用真实 Claude Code 客户端做端到端验证：把 ANTHROPIC_BASE_URL 指向本机代理，走 /v1/messages。
#
# 为什么值得做这一层：前面那些测试是我按协议规范构造的请求，而 Claude Code 才是真正的客户端 ——
# 它的 system 提示、工具定义、流式消费方式都是真实的，能验证「规范上对」和「客户端真的能用」之间的差距。
#
# --no-session-persistence：不写入会话历史，避免污染既有会话。
# 不带 --dangerously-skip-permissions：需要授权的工具会被拒，但工具调用与工具结果回灌这两条路径
# 依然会被走到（Claude Code 会把拒绝作为 tool_result 回灌），足够验证协议。
#
# 用法: BASE=http://127.0.0.1:3251 KEY=xxx PROMPT="..." bash scripts/test-claude-code-e2e.sh
set -u

BASE="${BASE:-http://127.0.0.1:3251}"
KEY="${KEY:-test-proxy-key-abc123}"
MODEL="${MODEL:-cline-pass/deepseek-v4.1-flash}"
PROMPT="${PROMPT:-回答两个字：收到}"

export ANTHROPIC_BASE_URL="$BASE"
export ANTHROPIC_AUTH_TOKEN="$KEY"
export ANTHROPIC_API_KEY="$KEY"
export ANTHROPIC_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL"
export ANTHROPIC_DEFAULT_FABLE_MODEL="$MODEL"
export CLAUDE_CODE_SUBAGENT_MODEL="$MODEL"
# 清掉外层 Claude Code 的环境痕迹，避免被识别成嵌套会话而改变行为
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT CLAUDE_CODE_SSE_PORT_AUTH 2>/dev/null || true

echo "→ BASE=$BASE"
echo "→ MODEL=$MODEL"
echo "→ PROMPT=$PROMPT"
echo "---"

claude -p "$PROMPT" --no-session-persistence 2>&1
code=${PIPESTATUS[0]:-$?}
echo "---"
echo "退出码: $code"
exit "$code"