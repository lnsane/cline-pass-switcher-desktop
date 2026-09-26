#!/usr/bin/env bash
# 真实 Claude Code 端到端验证用量统计：
# 起隔离引擎 → 用一份指向它的 settings 让真 Claude Code 跑一次对话（含工具调用）
# → 检查用量被记下来 → 停掉引擎（模拟「不开代理也能统计」）→ 扫描会话记录补齐
# 全程独立端口与独立数据目录，不碰用户的 3199。
set -u
cd /c/Users/wangc/Desktop/cline-pass-switcher-desktop

PORT=${E2E_USAGE_PORT:-3499}
DATA="$LOCALAPPDATA/Temp/usage-e2e"
PROJ="$DATA/projects"
rm -rf "$DATA" && mkdir -p "$DATA" "$PROJ"

# 隔离配置：拷真实账号密钥，改端口
node -e "
const fs=require('fs'),path=require('path');
const real=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'Cline Pass Switcher','config.json'),'utf8'));
real.port=Number(process.argv[1]);
fs.writeFileSync(process.argv[2]+'/config.json', JSON.stringify(real,null,2));
" "$PORT" "$DATA"

echo "=== 1) 起隔离引擎（端口 $PORT）==="
DATA_DIR="$DATA" CLAUDE_PROJECTS_DIR="$PROJ" node src/main/engine/engine.js > "$DATA/engine.log" 2>&1 &
ENGINE_PID=$!
until curl -s -m 2 "http://127.0.0.1:$PORT/api/meta" >/dev/null 2>&1; do sleep 1; done
echo "  引擎就绪"

echo
echo "=== 2) 真 Claude Code 走这个代理跑一次对话（带工具调用）==="
cat > "$DATA/settings.json" <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:$PORT",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-no-key",
    "ANTHROPIC_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "cline-pass/deepseek-v4.1-flash"
  }
}
EOF
mkdir -p "$DATA/work" && cd "$DATA/work"
echo '{"name":"usage-e2e-probe","version":"9.9.9"}' > package.json

CLAUDE_PROJECTS_DIR="$PROJ" env -u ANTHROPIC_BASE_URL -u ANTHROPIC_AUTH_TOKEN -u ANTHROPIC_MODEL \
  claude --settings "$DATA/settings.json" -p "Read ./package.json and tell me the version field. Reply with just the version." \
  --no-session-persistence --allowedTools "Read" 2>&1 \
  | grep -viE "unrecognized_model|isn't described|^\s*$" | tail -3
cd /c/Users/wangc/Desktop/cline-pass-switcher-desktop

sleep 1
echo
echo "=== 3) 代理侧记下的用量 ==="
node -e "
fetch('http://127.0.0.1:'+process.argv[1]+'/api/usage?days=7').then(r=>r.json()).then(u=>{
  console.log('  请求数: '+u.totals.requests+'  成功: '+u.totals.success);
  console.log('  input='+u.totals.input+'  output='+u.totals.output+'  cache_read='+u.totals.cacheRead);
  console.log('  成本: \$'+u.totals.cost.toFixed(6)+'（真实 \$'+u.totals.costReal.toFixed(6)+' + 估算 \$'+u.totals.costEstimated.toFixed(6)+'）');
});
" "$PORT"
node -e "
fetch('http://127.0.0.1:'+process.argv[1]+'/api/usage/records?limit=5').then(r=>r.json()).then(x=>{
  console.log('  明细（最近 '+x.records.length+' 条）:');
  for(const r of x.records.slice(0,5)) console.log('    ['+r.source+'] '+r.model+'  in='+r.input+' out='+r.output+' cache='+r.cacheRead+' cost='+r.cost+' 渠道='+r.provider);
});
" "$PORT"

echo
echo "=== 4) 停掉引擎（模拟「不开代理」），用会话记录扫描补齐 ==="
kill $ENGINE_PID 2>/dev/null; wait $ENGINE_PID 2>/dev/null
echo "  引擎已停"

echo
echo "=== 5) 扫描 Claude Code 会话记录 ==="
node -e "
const fs=require('fs'),path=require('path');
const DATA=process.argv[1], PROJ=process.argv[2];
process.env.DATA_DIR=DATA;
process.env.CLAUDE_PROJECTS_DIR=PROJ;
import('./src/main/engine/usage.js').then(async (m)=>{
  const store=m.createUsageStore(path.join(DATA,'usage2'));
  const r=m.scanClaudeSessions({projectsDir:PROJ, sync:store.sync, store});
  console.log('  扫描: 文件='+r.files+' 记录='+r.scanned+' 新增='+r.added+' 跳过='+r.skipped);
  const days=Object.keys(store.daily).sort();
  console.log('  覆盖日期: '+(days.join(', ')||'(无)'));
  let tot={req:0,inp:0,out:0,cr:0};
  for(const d of days) for(const r2 of Object.values(store.daily[d].rollups)){ tot.req+=r2.requests; tot.inp+=r2.input; tot.out+=r2.output; tot.cr+=r2.cacheRead; }
  console.log('  会话侧合计: '+tot.req+' 次请求  in='+tot.inp+' out='+tot.out+' cache='+tot.cr);
  if(tot.req>0) console.log('  ✓ 不开代理也能统计到用量');
  else console.log('  ✗ 没扫到任何记录');
});
" "$DATA" "$PROJ"

echo
echo "=== 6) 确认用户的 3199 未受影响 ==="
netstat -ano 2>/dev/null | grep LISTENING | grep ":3199" | head -2 | sed 's/^/  /' || echo "  (3199 未监听)"

echo
echo "=== 清理 ==="
for pid in $(netstat -ano 2>/dev/null | grep LISTENING | grep -E ":$PORT\b" | awk '{print $5}' | sort -u); do
  taskkill //PID $pid //T //F >/dev/null 2>&1 && echo "  关闭 PID $pid"
done
rm -rf "$DATA"
echo "完成"
