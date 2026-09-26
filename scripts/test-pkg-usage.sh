#!/usr/bin/env bash
# 打包版冒烟测试（2.2.0）：验证「用量统计」在真实打包产物里工作
# 用解包版（Smart App Control 会拦安装包，但解包版和安装后跑的是同一份代码）
# 全程隔离：独立数据目录、独立端口，不碰用户的 3199。
set -u
cd /c/Users/wangc/Desktop/cline-pass-switcher-desktop

SM="$LOCALAPPDATA/Temp/pkg-usage-test"
PORT=9488
ENGINE_PORT=3488
EXE="dist/win-unpacked/Cline Pass Switcher.exe"
REAL_MD5_BEFORE=$(md5sum "$HOME/.claude/settings.json" 2>/dev/null | cut -d' ' -f1)

if [ ! -f "$EXE" ]; then echo "✗ 找不到解包版: $EXE"; exit 1; fi
echo "解包版就绪（$(stat -c %s "$EXE") 字节）"

rm -rf "$SM" && mkdir -p "$SM"
node -e "
const fs=require('fs'),path=require('path');
const real=JSON.parse(fs.readFileSync(path.join(process.env.APPDATA,'Cline Pass Switcher','config.json'),'utf8'));
real.port=Number(process.argv[2]); real.proxyKey='';
fs.writeFileSync(process.argv[1]+'/config.json', JSON.stringify(real,null,2));
console.log('  夹具就绪：引擎端口 '+process.argv[2]);
" "$SM" "$ENGINE_PORT"

"$EXE" --user-data-dir="C:\\Users\\wangc\\AppData\\Local\\Temp\\pkg-usage-test" --remote-debugging-port=$PORT > /tmp/pkg-usage.log 2>&1 &
until curl -s -m 3 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1; do sleep 3; done
echo "调试端口就绪"
until [ "$(node scripts/cdp.mjs --port=$PORT eval "(window.APP && window.APP.boot)===true" 2>/dev/null | tr -d '\r\n ')" = "true" ]; do sleep 3; done
echo "应用启动完成"

echo
echo "=== 1) 版本号 ==="
node scripts/cdp.mjs --port=$PORT eval "({ 标题栏: (document.getElementById('brandVer')||{}).textContent, boot: window.APP.boot.version })" 2>&1 | tail -3

echo "=== 2) 用量视图已注册且可进入 ==="
node scripts/cdp.mjs --port=$PORT eval "window.APP.nav('usage').then(function(){ return JSON.stringify({ 导航项: !!document.querySelector('[data-view=usage]'), 标题: (document.getElementById('viewTitle')||{}).textContent, KPI数: document.querySelectorAll('.stat-tile').length, 趋势图数: document.querySelectorAll('.spark').length }) })" 2>&1 | tail -3

echo "=== 3) 扫描会话记录（把真实历史补进来）==="
node scripts/cdp.mjs --port=$PORT eval "document.querySelector('[data-act=scan]').click(); 'clicked'" 2>&1 | tail -1
sleep 25
node scripts/cdp.mjs --port=$PORT eval "JSON.stringify({ KPI: Array.from(document.querySelectorAll('.stat-tile')).map(function(t){return t.querySelector('.stat-label').textContent+'='+t.querySelector('.stat-value').textContent;}), 副标题:(document.getElementById('viewSub')||{}).textContent })" 2>&1 | tail -3

echo "=== 4) 真实 Claude Code 走这个打包版的代理 ==="
cat > /tmp/pkg-usage-settings.json <<EOF
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:$ENGINE_PORT",
    "ANTHROPIC_AUTH_TOKEN": "local-proxy-no-key",
    "ANTHROPIC_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "cline-pass/deepseek-v4.1-flash",
    "ANTHROPIC_DEFAULT_OPUS_MODEL": "cline-pass/deepseek-v4.1-flash"
  }
}
EOF
mkdir -p /tmp/pkg-usage-work && cd /tmp/pkg-usage-work
timeout 120 claude --settings /tmp/pkg-usage-settings.json -p "Say exactly: PKG-USAGE-OK" --no-session-persistence < /dev/null 2>&1 \
  | grep -viE "unrecognized_model|isn't described|^\s*$" | tail -2
cd /c/Users/wangc/Desktop/cline-pass-switcher-desktop

sleep 3
echo "=== 5) 打包版记下的成本（真实 vs 估算要分开）==="
node scripts/cdp.mjs --port=$PORT eval "window.USAGE_VIEW.reload().then(function(){ return 'ok' })" 2>&1 | tail -1
sleep 5
node scripts/cdp.mjs --port=$PORT eval "JSON.stringify({ 花费: Array.from(document.querySelectorAll('.stat-tile')).filter(function(t){return t.querySelector('.stat-label').textContent==='花费';}).map(function(t){return t.querySelector('.stat-value').textContent+' | '+t.querySelector('.stat-sub').textContent;}), 来源表: Array.from(document.querySelectorAll('.card')).filter(function(c){return /按数据来源/.test((c.querySelector('.card-title')||{}).textContent||'');}).map(function(c){return Array.from(c.querySelectorAll('tbody tr')).map(function(r){return Array.from(r.querySelectorAll('td')).slice(0,3).map(function(d){return d.textContent.trim()}).join(' / ');});}) })" 2>&1 | tail -3

echo
echo "=== 清理 ==="
for pid in $(netstat -ano 2>/dev/null | grep LISTENING | grep -E ":($PORT|$ENGINE_PORT)\b" | awk '{print $5}' | sort -u); do
  taskkill //PID $pid //T //F >/dev/null 2>&1 && echo "  关闭 PID $pid"
done
taskkill //IM "Cline Pass Switcher.exe" //F >/dev/null 2>&1
sleep 2
rm -rf "$SM" /tmp/pkg-usage-work

REAL_MD5_AFTER=$(md5sum "$HOME/.claude/settings.json" 2>/dev/null | cut -d' ' -f1)
echo
echo "=== 用户真实的 3199 与 Claude 配置 ==="
netstat -ano 2>/dev/null | grep LISTENING | grep ":3199" | head -1 | sed 's/^/  3199: /' || echo "  3199: 未监听！"
echo "  settings.json md5: $REAL_MD5_BEFORE → $REAL_MD5_AFTER"
[ "$REAL_MD5_BEFORE" = "$REAL_MD5_AFTER" ] && echo "  ✓ Claude 配置一字未变" || echo "  ✗ 被改动了！"
echo "完成"
