@echo off
rem ============================================================================
rem  本地构建（Windows）—— 只构建，不打包安装包
rem
rem  产物：dist\win-unpacked\Cline Pass Switcher.exe
rem  双击即可运行，和装完后的程序是同一份代码。
rem
rem  为什么用「构建」而不是「打包」：
rem    1. 快得多 —— 不跑 NSIS / portable 那套压缩，省几分钟
rem    2. 不受 Smart App Control 拦截 —— 安装包是未签名 exe，会被 WDAC 策略挡掉；
rem       解包版不受影响（详见 README 的「已知边界」）
rem    3. 调试方便 —— 改完代码重跑本脚本，直接起 dist\win-unpacked 里的 exe
rem
rem  要出正式的安装包 / 免安装单文件，用 npm run dist:win（或 git tag 触发 CI）。
rem
rem  用法（双击本文件，或在 cmd 里执行）：
rem    scripts\build-win.bat            构建 x64
rem    scripts\build-win.bat --clean    先删 dist\ 再构建
rem    scripts\build-win.bat --run      构建完直接启动
rem
rem  本文件存的是 GBK(cp936) —— cmd.exe 按系统码页解析批处理文件本身，
rem  存成 UTF-8 的话中文会被解析成乱码甚至把行拆断（代码行全是 ASCII，不受影响）。
rem ============================================================================

rem 记下当前码页，退出前切回去，不给用户的 cmd 会话留副作用
for /f "tokens=2 delims=:" %%A in ('chcp') do set "OLDCP=%%A"
chcp 936 >nul
setlocal enabledelayedexpansion

rem 仓库根目录（本文件在 scripts\ 下）
for %%I in ("%~dp0..") do set "ROOT=%%~fI"
cd /d "%ROOT%"

set "CLEAN=0"
set "RUN=0"
set "TMPF=%TEMP%\cps-build-%RANDOM%%RANDOM%.txt"

rem ---------------------------------------------------------------- 参数
:parse
if "%~1"=="" goto parsed
if /i "%~1"=="--clean" goto arg_clean
if /i "%~1"=="--run"   goto arg_run
if /i "%~1"=="-h"      goto usage
if /i "%~1"=="--help"  goto usage
echo 未知参数: %~1
echo 用 --help 看用法。
goto fail_plain

:arg_clean
set "CLEAN=1"
shift
goto parse

:arg_run
set "RUN=1"
shift
goto parse

:parsed
where node >nul 2>nul || goto no_node
where npm  >nul 2>nul || goto no_node

rem ------------------------------------------------- 安全检查：别碰正在跑的实例
rem dist\win-unpacked 里的 exe 往往就是「日常在用的那份程序」（双击即用）。
rem 那种情况下 --clean 会把正在服务的代理正在用的文件删掉；不 --clean 也会因为
rem exe 被占用而白构建一场，最后才报 EBUSY。
rem 所以这里提前停下并说明，绝不替用户结束进程 —— 那个进程可能正在转发请求。
rem 要「构建完立刻起回来」，用 --run。
powershell -NoProfile -ExecutionPolicy Bypass -Command "$r='%ROOT%\dist'; @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($r,[StringComparison]::OrdinalIgnoreCase) }) | ForEach-Object { $_.Id }" > "%TMPF%" 2>nul
set "PIDS="
for /f "usebackq delims=" %%A in ("%TMPF%") do set "PIDS=!PIDS! %%A"
del "%TMPF%" 2>nul
if defined PIDS goto in_use

rem 国内下载 Electron 容易超时，默认走镜像；已设过就不覆盖
if not defined ELECTRON_MIRROR set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
if not defined ELECTRON_BUILDER_BINARIES_MIRROR set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

rem ---------------------------------------------------------------- 构建
if not "%CLEAN%"=="1" goto after_clean
echo ==^> 清理 dist\
if exist dist rmdir /s /q dist
if exist dist goto clean_failed

:after_clean
if exist node_modules goto deps_ok
echo ==^> 安装依赖
call npm install || goto fail_build

:deps_ok
echo ==^> 生成图标
call node scripts/make-icon.mjs || goto fail_build

echo ==^> 构建（electron-builder --dir，不打包安装器）
call npx electron-builder --win --x64 --dir || goto fail_build

set "EXE=dist\win-unpacked\Cline Pass Switcher.exe"
if not exist "%EXE%" goto no_artifact

for %%I in ("%EXE%") do set "BYTES=%%~zI"
set /a MB=!BYTES!/1048576
set "VER="
node -p "require('./package.json').version" > "%TMPF%" 2>nul
set /p VER=<"%TMPF%"
del "%TMPF%" 2>nul
if not defined VER set "VER=?"

echo.
echo 构建完成
echo   产物: %EXE%  （!MB! MB）
echo   版本: %VER%
echo.
echo   直接运行：  "%EXE%"
echo   或：        scripts\build-win.bat --run

if not "%RUN%"=="1" goto done
echo.
echo ==^> 启动
start "" "%EXE%"

:done
call :restore_cp
endlocal
goto maybe_pause_ok

rem ---------------------------------------------------------------- 出错分支
:in_use
echo.
echo 构建中止：本仓库 dist\ 下的程序正在运行（PID:%PIDS%）
echo.
echo   那份正在跑的就是 dist\win-unpacked\Cline Pass Switcher.exe。
echo   --clean 会把它的文件删掉；不 --clean 也会因为文件被占用而构建失败。
echo   所以这里直接停下，不会替你结束进程。
echo.
echo   请先退出那个程序（托盘图标右键退出）再重跑本脚本；
echo   想构建完立刻起回来，用：scripts\build-win.bat --run
goto fail_plain

:clean_failed
echo dist\ 删不干净 —— 多半还有进程占着里面的文件。
echo   请退出正在运行的 Cline Pass Switcher 后重试。
goto fail_plain

:no_artifact
echo 构建产物没找到：%EXE%
echo   dist\ 下现有内容：
dir /b dist 2>nul
goto fail_plain

:fail_build
echo.
echo 构建失败，报错见上。
goto fail_plain

:fail_plain
call :restore_cp
endlocal
goto maybe_pause_fail

:no_node
echo 找不到 node / npm。
echo   请先安装 Node.js 18 或更高版本：https://nodejs.org/
goto fail_plain

:usage
echo 本地构建（Windows）—— 只构建，不打包安装包
echo.
echo   scripts\build-win.bat             构建 x64
echo   scripts\build-win.bat --clean     先删 dist\ 再构建
echo   scripts\build-win.bat --run       构建完直接启动
echo.
echo 产物：dist\win-unpacked\Cline Pass Switcher.exe
echo 要出正式安装包 / 免安装单文件：npm run dist:win
call :restore_cp
endlocal
goto maybe_pause_ok

rem ============================================================================
rem  双击运行时，脚本一退出窗口就关了，报错信息根本来不及看 —— 所以停一下等按键。
rem
rem  什么时候不暂停（避免卡住自动化）：
rem    - 从管道 / 重定向调用：pause 在非交互 stdin 下会立刻返回，不会卡住
rem    - 显式设了 CPS_NO_PAUSE=1
rem  下面这段注释刻意只用 ASCII：插入时不必再考虑码页问题。
rem ============================================================================
:maybe_pause_ok
if defined CPS_NO_PAUSE goto :eof
echo.
pause
exit /b 0

:maybe_pause_fail
if defined CPS_NO_PAUSE exit /b 1
echo.
pause
exit /b 1

rem 把控制台码页切回原来的，别让用户的 cmd 会话停在别的码页
:restore_cp
if defined OLDCP chcp %OLDCP% >nul
goto :eof