#!/usr/bin/env bash
# 本地构建（Windows）—— 只构建，不打包安装包
#
# 产物：dist/win-unpacked/Cline Pass Switcher.exe
# 双击即可运行，和装完后的程序是同一份代码。
#
# 为什么用「构建」而不是「打包」：
#   1. 快得多 —— 不跑 NSIS/portable 那套压缩与签名，省几分钟
#   2. 不受 Smart App Control 拦截 —— 安装包是未签名 exe，会被 WDAC 策略挡掉；
#      解包版不受影响（详见 README 的「已知边界」）
#   3. 调试方便 —— 改代码后重跑本脚本，直接起 dist/win-unpacked 里的 exe
#
# 要出正式的安装包/免安装单文件，用 npm run dist:win（或 git tag 触发 CI）。
#
# 用法:
#   bash scripts/build-win.sh              # 构建 x64
#   bash scripts/build-win.sh --clean      # 先删 dist/ 再构建
#   bash scripts/build-win.sh --run        # 构建完直接启动
set -euo pipefail

cd "$(dirname "$0")/.."

CLEAN=0
RUN=0
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --run)   RUN=1 ;;
    -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（用 --help 看用法）"; exit 1 ;;
  esac
done

# 国内下载 Electron 容易超时，默认走镜像；已设过就不覆盖
export ELECTRON_MIRROR="${ELECTRON_MIRROR:-https://npmmirror.com/mirrors/electron/}"
export ELECTRON_BUILDER_BINARIES_MIRROR="${ELECTRON_BUILDER_BINARIES_MIRROR:-https://npmmirror.com/mirrors/electron-builder-binaries/}"

if [ "$CLEAN" = "1" ]; then
  echo "==> 清理 dist/"
  rm -rf dist
fi

if [ ! -d node_modules ]; then
  echo "==> 安装依赖"
  npm install
fi

echo "==> 生成图标"
node scripts/make-icon.mjs

echo "==> 构建（electron-builder --dir，不打包安装器）"
npx electron-builder --win --x64 --dir

EXE="dist/win-unpacked/Cline Pass Switcher.exe"
if [ ! -f "$EXE" ]; then
  echo "✗ 构建产物没找到: $EXE"
  exit 1
fi

SIZE=$(stat -c %s "$EXE" 2>/dev/null || stat -f %z "$EXE")
echo
echo "✓ 构建完成"
echo "  产物: $EXE  ($((SIZE / 1048576)) MB)"
echo "  版本: $(node -p "require('./package.json').version")"
echo
echo "  直接运行：  \"$EXE\""
echo "  或：        bash scripts/build-win.sh --run"

if [ "$RUN" = "1" ]; then
  echo
  echo "==> 启动"
  "$EXE" &
fi
