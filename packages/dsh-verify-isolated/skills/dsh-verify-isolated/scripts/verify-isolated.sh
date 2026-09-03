#!/usr/bin/env bash
# 隔离环境浏览器验证一键脚本（dsh-verify-isolated 插件包配套，随本 skill 分发）。
#
# 用途：在不污染真实 ~/.dsh（含正在使用的 web profile）的前提下，拉起一个
# 完全隔离的 dsh web 实例，用于客户端 UI 改动的浏览器实测。
#
# 双重隔离：
#   1. DSH_HOME 指向全新临时目录 —— 隔离凭据 / 会话 / home 级 cordis.patch.yml；
#   2. 独立 profile verify_<8位随机> —— 隔离插件组合栈，不触碰用户 web profile。
#
# 最小依赖（实测验证）：
#   - dsh 安装目录自带 @deepseek-ai/dsh-base 与 @deepseek-ai/dsh-web-app，
#     按名从安装目录解析，不写进 dependencies、不走 npm（dsh-web-app 的依赖
#     @deepseek-ai/dsh-frontend 不在 registry，dsh plugin add 走 npm 会 404）。
#   - 故脚本用 node 把 @deepseek-ai/dsh-web-app 注入 profile 的
#     dsh.profile.bundles（紧跟 @deepseek-ai/dsh-base 之后），再添加用户插件。
#
# 用法：
#   verify-isolated.sh [--port <port>] [--browser] [--keep] [--no-build] [-- <pkg-path>...]
#
#   默认：端口 3456（--port 0 自动探测真实空闲端口），结束后自动清理临时
#   DSH_HOME 与 profile。
#   --browser 额外启动独立浏览器实例（scripts/browser-driver.mjs，raw CDP 零依赖）：
#     独立 user-data-dir + 自选空闲调试端口 + headless，实例信息写入
#     $ISOLATED_HOME/browser.state（与 DSH_HOME 同生命周期，退出随 trap 一并清理，
#     多会话并行各自独立、互不串扰）。浏览器操作命令见 browser-driver.mjs --help。
#   --keep     结束后保留临时 DSH_HOME（不删，方便排查；路径会打印）
#   --no-build 跳过挂载前的 pnpm build（默认会构建每个插件，保证 lib/ 或 dist/ 产物存在）
#   --         之后的位置参数为要挂载的本地插件路径（相对路径基于当前 cwd 解析）
#
# 示例（在插件仓库根执行）：
#   verify-isolated.sh packages/dsh-mcp-manager
#   verify-isolated.sh --port 0 --browser packages/dsh-notifier packages/dsh-mcp-manager
# 绝对路径亦可：
#   verify-isolated.sh /path/to/repo/packages/dsh-mcp-manager
set -euo pipefail

PORT=3456
KEEP=0
BUILD=1
BROWSER=0
PKGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --browser) BROWSER=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --) shift; PKGS+=("$@"); break ;;
    -*) echo "未知选项: $1" >&2; exit 2 ;;
    *) PKGS+=("$1"); shift ;;
  esac
done

# 本脚本目录（browser-driver.mjs 同目录随 skill 分发）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 修复 --port 0：dsh 收到 --port 0 会自行随机分配，但脚本打印仍是 0、无法访问，
# 也无从得知实际端口——这里先用 node 探测一个真实空闲端口，再传给 dsh。
if [[ "$PORT" -eq 0 ]]; then
  PORT="$(node -e '
    const net = require("node:net");
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const p = srv.address().port;
      srv.close(() => console.log(p));
    });
  ')"
  echo "（--port 0）已探测空闲端口: $PORT"
fi

# 1. 第一层隔离：全新临时 DSH_HOME（隔离全部用户数据）
ISOLATED_HOME="$(mktemp -d)"
export DSH_HOME="$ISOLATED_HOME"
PROFILE="verify_$(openssl rand -hex 4)"
BROWSER_STATE="$ISOLATED_HOME/browser.state"
cleanup() {
  # --browser：先优雅关闭浏览器实例（CDP Browser.close + kill 兜底），
  # 再清理 DSH_HOME——user-data-dir 在 ISOLATED_HOME 内，随 rm -rf 一并删除，
  # 进程与临时目录双重保障无残留（Ctrl+C / 崩溃 / 正常退出均走 EXIT trap）。
  if [[ "$BROWSER" -eq 1 && -f "$BROWSER_STATE" ]]; then
    echo "清理浏览器实例（browser-driver quit）..."
    node "$SCRIPT_DIR/browser-driver.mjs" quit --state "$BROWSER_STATE" --json >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP" -eq 1 ]]; then
    echo "（--keep）临时 DSH_HOME 保留于: $ISOLATED_HOME"
    echo "（--keep）如需删除: rm -rf '$ISOLATED_HOME'"
  else
    rm -rf "$ISOLATED_HOME"
  fi
}
trap cleanup EXIT

# 2. 初始化独立 profile（verify_<随机>，含 dsh-base 模板）
dsh plugin --profile "$PROFILE" add --help >/dev/null

# 3. 注入内置 web-app bundle（按名从 dsh 安装目录解析，不走 npm）
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const base = j.dsh.profile.bundles;
  if (!base.includes("@deepseek-ai/dsh-base")) base.unshift("@deepseek-ai/dsh-base");
  if (!base.includes("@deepseek-ai/dsh-web-app")) {
    const i = base.indexOf("@deepseek-ai/dsh-base");
    base.splice(i + 1, 0, "@deepseek-ai/dsh-web-app");
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$DSH_HOME/profiles/$PROFILE/package.json"

# 4. 挂载本地插件（相对路径基于当前 cwd，dsh 官方会锚定到调用目录；绝对路径原样使用）
if [[ ${#PKGS[@]} -gt 0 ]]; then
  # 4a. 先构建每个插件（默认）：dsh 直读构建产物（hub 的 lib/、xiaozhuge 的 dist/），
  #     不 build 则 link 到的源码目录缺产物、启动即 ERR_MODULE_NOT_FOUND
  if [[ "$BUILD" -eq 1 ]]; then
    for pkg in "${PKGS[@]}"; do
      # 支持相对路径（基于当前 cwd）与绝对路径；目录或仓库根均可
      pkg_abs="$(cd "$(pwd)" && realpath -m "$pkg")"
      if [[ -f "$pkg_abs/package.json" ]] && grep -q '"build"' "$pkg_abs/package.json"; then
        echo "构建插件: $pkg_abs"
        (cd "$pkg_abs" && pnpm build)
      else
        echo "跳过构建（无 build 脚本）: $pkg_abs"
      fi
    done
  fi
  dsh plugin --profile "$PROFILE" add "${PKGS[@]}" >/dev/null
fi

# 5. 启动独立浏览器实例（--browser）：独立 user-data-dir + 自选空闲调试端口，
#    实例信息写入 $BROWSER_STATE（与 DSH_HOME 同生命周期，exit trap 统一清理）。
if [[ "$BROWSER" -eq 1 ]]; then
  node "$SCRIPT_DIR/browser-driver.mjs" launch \
    --state "$BROWSER_STATE" \
    --user-data-dir "$ISOLATED_HOME/browser-profile" \
    --json
  # 把 dsh web 实际端口并入 state（浏览器调试端口已由 launch 写入），供并行任务核对
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.dshWebPort = Number(process.argv[2]);
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  ' "$BROWSER_STATE" "$PORT"
  echo "浏览器实例就绪: state=$BROWSER_STATE（操作命令见 browser-driver.mjs --help）"
fi

echo "隔离环境就绪: DSH_HOME=$ISOLATED_HOME  profile=$PROFILE"
echo "启动 dsh web 于 http://127.0.0.1:$PORT （Ctrl+C 退出并自动清理）"
# 6. 前台启动（阻塞）。不用 exec：exec 会替换 shell，dsh 被 Ctrl+C/SIGTERM 杀掉时
#    EXIT trap 不触发、临时目录残留。前台子进程 + EXIT trap 保证任何退出都清理。
dsh --profile "$PROFILE" --port "$PORT" --no-open