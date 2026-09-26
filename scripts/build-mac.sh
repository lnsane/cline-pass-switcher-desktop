#!/usr/bin/env bash
# 本地构建（macOS）—— 只构建，不打包 dmg
#
# 产物：dist/mac/Cline Pass Switcher.app（Apple Silicon 上是 dist/mac-arm64/）
# 双击或用 open 命令即可运行。
#
# 必须在 macOS 上跑 —— Windows 打不了 mac 包（electron-builder 需要 macOS
# 的原生工具链与代码签名）。要出 dmg，用 npm run dist:mac 或推 tag 触发 CI。
#
# 用法:
#   bash scripts/build-mac.sh                # 构建当前架构
#   bash scripts/build-mac.sh --arm64        # 强制 Apple Silicon
#   bash scripts/build-mac.sh --x64          # 强制 Intel
#   bash scripts/build-mac.sh --clean        # 先删 dist/ 再构建
#   bash scripts/build-mac.sh --run          # 构建完直接启动
set -euo pipefail

cd "$(dirname "$0")/.."

CLEAN=0
RUN=0
ARCH=""
for arg in "$@"; do
  case "$arg" in
    --arm64) ARCH="arm64" ;;
    --x64)   ARCH="x64" ;;
    --clean) CLEAN=1 ;;
    --run)   RUN=1 ;;
    -h|--help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "未知参数: $arg（用 --help 看用法）"; exit 1 ;;
  esac
done

if [ "$(uname -s)" != "Darwin" ]; then
  echo "✗ 这个脚本只能在 macOS 上跑（当前: $(uname -s)）"
  echo "  Windows 上用 scripts/build-win.sh；要出 mac 包请推 tag 让 CI 打。"
  exit 1
fi

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

if [ -z "$ARCH" ]; then
  case "$(uname -m)" in
    arm64) ARCH="arm64" ;;
    *)     ARCH="x64" ;;
  esac
fi

echo "==> 构建（electron-builder --dir，不打包 dmg，架构 $ARCH）"
npx electron-builder --mac "--$ARCH" --dir

# electron-builder 的 mac 输出目录：arm64 用 mac-arm64，x64 用 mac
APP=""
for d in "dist/mac-arm64" "dist/mac"; do
  if [ -d "$d/Cline Pass Switcher.app" ]; then APP="$d/Cline Pass Switcher.app"; break; fi
done

if [ -z "$APP" ]; then
  echo "✗ 构建产物没找到（在 dist/mac* 下找不到 .app）"
  ls -la dist/ 2>/dev/null || true
  exit 1
fi

echo
echo "✓ 构建完成"
echo "  产物: $APP  ($(du -sh "$APP" | cut -f1))"
echo "  版本: $(node -p "require('./package.json').version")"
echo
echo "  直接运行：  open \"$APP\""
echo "  或：        bash scripts/build-mac.sh --run"
echo
echo "  提示：未签名的 .app 首次打开会被 Gatekeeper 拦。"
echo "       右键 → 打开，或执行：xattr -cr \"$APP\""

if [ "$RUN" = "1" ]; then
  echo
  echo "==> 启动"
  open "$APP"
fi
