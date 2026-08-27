#!/usr/bin/env bash
# 隔离环境浏览器验证一键脚本（docs/ISOLATED-VERIFICATION.md 配套）。
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
#   scripts/verify-isolated.sh [--port <port>] [--keep] [-- <pkg-path>...]
#
#   默认：端口 3456（--port 0 让系统随机），结束后自动清理临时 DSH_HOME 与 profile。
#   --keep     结束后保留临时 DSH_HOME（不删，方便排查；路径会打印）
#   --         之后的位置参数为要挂载的本地插件路径（主 checkout 的 packages/*）
#
# 示例：
#   scripts/verify-isolated.sh packages/dsh-mcp-manager
#   scripts/verify-isolated.sh --port 0 packages/dsh-notifier packages/dsh-mcp-manager
set -euo pipefail

PORT=3456
KEEP=0
PKGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --) shift; PKGS+=("$@"); break ;;
    -*) echo "未知选项: $1" >&2; exit 2 ;;
    *) PKGS+=("$1"); shift ;;
  esac
done

# 仓库根（脚本位于 <root>/scripts/）
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1. 第一层隔离：全新临时 DSH_HOME（隔离全部用户数据）
ISOLATED_HOME="$(mktemp -d)"
export DSH_HOME="$ISOLATED_HOME"
PROFILE="verify_$(openssl rand -hex 4)"
cleanup() {
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

# 4. 挂载本地插件（主 checkout 的 packages/*，link 进 profile）
if [[ ${#PKGS[@]} -gt 0 ]]; then
  dsh plugin --profile "$PROFILE" add "${PKGS[@]/#/$ROOT/}" >/dev/null
fi

echo "隔离环境就绪: DSH_HOME=$ISOLATED_HOME  profile=$PROFILE"
echo "启动 dsh web 于 http://127.0.0.1:$PORT （Ctrl+C 退出并自动清理）"
# 5. 前台启动（阻塞）；退出时 trap 自动清理
exec dsh --profile "$PROFILE" --port "$PORT" --no-open
