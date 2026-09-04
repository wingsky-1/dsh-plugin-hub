#!/usr/bin/env bash
# 隔离环境浏览器验证一键脚本（dsh-verify-isolated 插件包配套，随本 skill 分发）。
#
# 用途：在不污染真实 ~/.dsh（含正在使用的 web profile）的前提下，拉起一个
# 完全隔离的 dsh web 实例，用于客户端 UI 改动的浏览器实测。
#
# 四重隔离：
#   1. DSH_HOME 指向全新临时目录 —— 隔离凭据 / 会话 / home 级 cordis.patch.yml；
#   2. 独立 profile verify_<8位随机> —— 隔离插件组合栈，不触碰用户 web profile；
#   3. 独立端口 + 显式回环（--host 127.0.0.1）—— 当前 dsh 默认即回环，显式写死
#      把隐式行为钉成结构性保证，防上游默认变更；
#   4. --browser 时独立浏览器实例（browser-driver.mjs，raw CDP 零依赖）。
# 隔离环境同时显式 DSH_TELEMETRY_DISABLED=1：测试数据不外发遥测。
#
# 依赖：
#   - node（profile 初始化校验 / bundle 注入 / 端口探测 / 产物校验 / 就绪断言均走
#     node，零新增系统依赖）；bash + coreutils 基础面。
#   - dsh 安装目录自带 @deepseek-ai/dsh-base 与 @deepseek-ai/dsh-web-app，
#     按名从安装目录解析，不写进 dependencies、不走 npm（dsh-web-app 的依赖
#     @deepseek-ai/dsh-frontend 不在 registry，dsh plugin add 走 npm 会 404）。
#   - 故脚本用 node 把 @deepseek-ai/dsh-web-app 注入 profile 的
#     dsh.profile.bundles（紧跟 @deepseek-ai/dsh-base 之后），再添加用户插件。
#
# 用法：
#   verify-isolated.sh [--dsh <path>] [--port <port>] [--browser] [--keep] [--no-build] [-- <pkg-path>...]
#
#   --dsh <path>  指定 dsh 入口（默认 PATH 中的 dsh）。隔离实测必须锚定目标 dsh
#                 版本——PATH 里碰巧存在的版本会让验证结果不可复现（#376 H1）。
#   默认：端口 3456（--port 0 自动探测真实空闲端口），结束后自动清理临时
#   DSH_HOME 与 profile。
#   --browser 额外启动独立浏览器实例（scripts/browser-driver.mjs，raw CDP 零依赖）：
#     独立 user-data-dir + 自选空闲调试端口 + headless，实例信息写入
#     $ISOLATED_HOME/browser.state（与 DSH_HOME 同生命周期，退出随 trap 一并清理，
#     多会话并行各自独立、互不串扰）。浏览器操作命令见 browser-driver.mjs --help。
#   --keep     结束后保留临时 DSH_HOME（不删，方便排查；路径会打印）
#   --no-build 跳过挂载前的 pnpm build（默认会构建每个插件，保证 lib/ 或 dist/
#              产物存在）；此时校验产物存在（缺失即报可操作错误），并对比 src/
#              与产物的 mtime，源码更新即给陈旧警告（防「存在但陈旧」锚定旧版本）
#   --         之后的位置参数为要挂载的插件：本地插件路径（相对/绝对；相对路径
#              基于当前 cwd 解析为绝对路径，规避 dsh 把非绝对路径当 git URL
#              解析——#517 C11）或包规格（npm 包名/git URL 原样透传）
#
# 示例（在插件仓库根执行）：
#   verify-isolated.sh packages/dsh-mcp-manager
#   verify-isolated.sh --port 0 --browser packages/dsh-notifier packages/dsh-mcp-manager
#   verify-isolated.sh --dsh /opt/dsh-0.1.2-alpha.2/bin/dsh --port 0 <插件路径>
# 绝对路径亦可：
#   verify-isolated.sh /path/to/repo/packages/dsh-mcp-manager
set -euo pipefail

PORT=3456
KEEP=0
BUILD=1
BROWSER=0
DSH_BIN=dsh
PKGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh) [[ $# -ge 2 ]] || { echo "错误: --dsh 需要一个路径参数" >&2; exit 2; }; DSH_BIN="$2"; shift 2 ;;
    --port) [[ $# -ge 2 ]] || { echo "错误: --port 需要一个端口参数" >&2; exit 2; }; PORT="$2"; shift 2 ;;
    --browser) BROWSER=1; shift ;;
    --keep) KEEP=1; shift ;;
    --no-build) BUILD=0; shift ;;
    --) shift; PKGS+=("$@"); break ;;
    -*) echo "未知选项: $1" >&2; exit 2 ;;
    *) PKGS+=("$1"); shift ;;
  esac
done

# 0. dsh 入口校验与版本锚定展示：--dsh 指定独立 prefix 安装的 dsh 时，隔离实例
#    必须确实用该版本拉起，否则验证结果无效（fail fast，不在建完环境后才失败）。
#    解析为绝对路径后全程用 $DSH_ABS 调用——真正锚定版本，防 PATH 漂移。
DSH_RAW="$(command -v "$DSH_BIN" 2>/dev/null || true)"
if [[ -z "$DSH_RAW" ]]; then
  echo "错误: 找不到 dsh 入口: $DSH_BIN（--dsh 需指向可执行的 dsh）" >&2
  exit 2
fi
DSH_ABS="$(node -e 'console.log(require("node:path").resolve(process.argv[1]))' "$DSH_RAW")"
if [[ ! -x "$DSH_ABS" ]]; then
  echo "错误: dsh 入口不可执行: $DSH_ABS（--dsh 需指向可执行的 dsh）" >&2
  exit 2
fi
echo "dsh 入口: $DSH_ABS ($("$DSH_ABS" --version 2>/dev/null | head -n 1))"

# 本脚本目录（browser-driver.mjs 同目录随 skill 分发）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 1. 第一层隔离：全新临时 DSH_HOME（隔离全部用户数据）
ISOLATED_HOME="$(mktemp -d)"
export DSH_HOME="$ISOLATED_HOME"
# profile 随机后缀走 node crypto（替代 openssl CLI，最小环境也可用）
PROFILE="verify_$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
BROWSER_STATE="$ISOLATED_HOME/browser.state"
DSH_PID=""
cleanup() {
  # 先停隔离 dsh web（后台子进程），再优雅关闭浏览器实例（CDP Browser.close +
  # kill 兜底），最后清理 DSH_HOME——user-data-dir 在 ISOLATED_HOME 内，随 rm -rf
  # 一并删除，进程与临时目录双重保障无残留（Ctrl+C / 崩溃 / 正常退出均走 EXIT trap）。
  if [[ -n "$DSH_PID" ]] && kill -0 "$DSH_PID" 2>/dev/null; then
    kill "$DSH_PID" 2>/dev/null || true
    wait "$DSH_PID" 2>/dev/null || true
  fi
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

# 2. 初始化独立 profile（verify_<随机>，含 dsh-base 模板）：显式用 plugin list
#    初始化（0.1.2-rc.1 实证会创建 profile 骨架），替代依赖「add --help 会顺带
#    初始化」的未文档化行为；失败 fail loudly 给可操作错误。
if ! "$DSH_ABS" plugin --profile "$PROFILE" list >/dev/null 2>&1; then
  echo "错误: profile 初始化失败（dsh plugin --profile $PROFILE list）——检查 dsh 入口与版本" >&2
  exit 1
fi

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

# 4. 挂载本地插件：先经 resolve-pkg-paths.mjs 归一化全部参数——**相对路径基于
#    当前 cwd 取绝对路径**（dsh 会把非绝对路径当 git URL 解析、报 `Repository
#    not found` 迷惑错误，#517 C11）；npm 包名/git URL 等包规格原样透传。
if [[ ${#PKGS[@]} -gt 0 ]]; then
  # 单次调用解析全部参数（替代逐包 node -e 子进程），输出每行一个归一化结果
  PKGS_ABS=()
  while IFS= read -r p; do PKGS_ABS+=("$p"); done < <(
    node "$SCRIPT_DIR/resolve-pkg-paths.mjs" -- "${PKGS[@]}"
  )
  # dsh 直读构建产物（hub 的 lib/、xiaozhuge 的 dist/），不 build 则 link 到的
  # 源码目录缺产物、启动即 ERR_MODULE_NOT_FOUND
  for pkg_abs in "${PKGS_ABS[@]}"; do
    # 插件目录须存在且为合法包（目录不存在/非插件目录给可操作错误，不等
    # dsh 的迷惑报错；包规格（npm 名/git URL）跳过本校验原样传给 dsh）
    if [[ ! -f "$pkg_abs/package.json" ]]; then
      echo "跳过: 非本地插件目录（无 package.json）: $pkg_abs（若为包名/git URL 将原样传给 dsh）"
      continue
    fi
    if [[ "$BUILD" -eq 1 ]]; then
      if [[ -f "$pkg_abs/package.json" ]] && grep -q '"build"' "$pkg_abs/package.json"; then
        echo "构建插件: $pkg_abs"
        (cd "$pkg_abs" && pnpm build)
      else
        echo "跳过构建（无 build 脚本）: $pkg_abs"
      fi
    else
      # --no-build：产物存在性校验（缺失即报可操作错误，不等启动时
      # ERR_MODULE_NOT_FOUND）+ 产物 vs src mtime 陈旧警告（#376 L2）
      if [[ ! -d "$pkg_abs/lib" && ! -d "$pkg_abs/dist" ]]; then
        echo "错误: --no-build 但缺少构建产物（lib/ 或 dist/）: $pkg_abs" >&2
        echo "       请先 pnpm build，或去掉 --no-build 让脚本自动构建" >&2
        exit 2
      fi
      node -e '
        const fs = require("node:fs"), path = require("node:path");
        const root = process.argv[1];
        const newest = (dir) => {
          let m = 0;
          const walk = (d) => {
            let es;
            try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
            for (const e of es) {
              const p = path.join(d, e.name);
              if (e.isDirectory()) walk(p);
              else if (e.isFile()) { const t = fs.statSync(p).mtimeMs; if (t > m) m = t; }
            }
          };
          walk(dir);
          return m;
        };
        const prods = ["lib", "dist"].map((d) => path.join(root, d)).filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
        if (prods.length === 0) return;
        const src = path.join(root, "src");
        const s = fs.existsSync(src) ? newest(src) : 0;
        const p = Math.max(...prods.map(newest));
        if (s > p) console.warn("警告: 源码比构建产物新（--no-build 可能验证到旧版本）: " + root);
      ' "$pkg_abs"
    fi
  done
  # add 统一用归一化后的绝对路径数组（相对路径在 dsh 侧会被当 git URL）
  if ! "$DSH_ABS" plugin --profile "$PROFILE" add "${PKGS_ABS[@]}" >/dev/null; then
    echo "错误: dsh plugin add 失败（已传入归一化路径）:" >&2
    for p in "${PKGS_ABS[@]}"; do echo "  - $p" >&2; done
    echo "       相对路径已按当前 cwd 解析为绝对路径（#517 C11）；请核对插件路径/包名" >&2
    exit 1
  fi
fi

# 5. 启动独立浏览器实例（--browser）：独立 user-data-dir + 自选空闲调试端口，
#    实例信息写入 $BROWSER_STATE（与 DSH_HOME 同生命周期，exit trap 统一清理）。
if [[ "$BROWSER" -eq 1 ]]; then
  node "$SCRIPT_DIR/browser-driver.mjs" launch \
    --state "$BROWSER_STATE" \
    --user-data-dir "$ISOLATED_HOME/browser-profile" \
    --json
  echo "浏览器实例就绪: state=$BROWSER_STATE（操作命令见 browser-driver.mjs --help）"
fi

# 6. 修复 --port 0：dsh 收到 --port 0 会自行随机分配，但脚本打印仍是 0、无法访问。
#    这里在 dsh 启动紧邻处用 node 探测真实空闲端口再传给 dsh——探测块必须贴近 dsh
#    启动，否则与绑定之间隔着构建/挂载的长耗时窗口，两并行任务可能探测到同一端口
#    导致 EADDRINUSE（PR #481 P2-1）。
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

# 7. 把 dsh web 实际端口并入 state（浏览器调试端口已由 launch 写入），供并行任务核对
if [[ "$BROWSER" -eq 1 && -f "$BROWSER_STATE" ]]; then
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    j.dshWebPort = Number(process.argv[2]);
    fs.writeFileSync(p, JSON.stringify(j, null, 2));
  ' "$BROWSER_STATE" "$PORT"
fi

echo "隔离环境就绪: DSH_HOME=$ISOLATED_HOME  profile=$PROFILE"
echo "启动 dsh web 于 http://127.0.0.1:$PORT （Ctrl+C 退出并自动清理）"
# 8. 启动（后台子进程 + 显式回环 + 遥测禁用）。不用 exec：exec 会替换 shell，
#    dsh 被杀时 EXIT trap 不触发、临时目录残留。后台 + wait 保持「前台阻塞」体感，
#    且 EXIT trap 能兜底 kill 残留 dsh；SIGINT（Ctrl+C）会同时送达同进程组的
#    dsh 子进程，wait 返回后 trap 统一清理。
#    --host 127.0.0.1：显式回环（#376 H2）；DSH_TELEMETRY_DISABLED=1：隔离环境
#    禁用遥测（0.1.2 线 profile-boot 消费的官方开关）。
DSH_TELEMETRY_DISABLED=1 "$DSH_ABS" --profile "$PROFILE" --host 127.0.0.1 --port "$PORT" --no-open &
DSH_PID=$!

# 9. 就绪断言（#376 M2）：轮询 HTTP 可达（GUI 带鉴权，2xx-4xx 均算就绪；5xx 与
#    连接失败继续等），每轮同时核对 dsh 进程存活——防「默认端口被其他服务占用、
#    探测连到占用者」的假阳性，也防 dsh 启动即崩时空等满 15s；15s 超时给可操作
#    错误而非裸崩溃。node 探测退出码：0=就绪、1=超时、2=进程已退出。
probe_rc=0
node -e '
  const port = process.argv[1], pid = Number(process.argv[2]);
  const deadline = Date.now() + 15000;
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const once = async () => {
    try {
      const r = await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(1500) });
      return r.status < 500;
    } catch { return false; }
  };
  (async () => {
    for (;;) {
      if (!alive()) process.exit(2);
      if (await once()) process.exit(0);
      if (Date.now() > deadline) process.exit(1);
      await new Promise((r) => setTimeout(r, 250));
    }
  })();
' "$PORT" "$DSH_PID" || probe_rc=$?
if [[ "$probe_rc" -eq 0 ]]; then
  echo "就绪断言通过: http://127.0.0.1:$PORT 已可达（pid=$DSH_PID）"
elif [[ "$probe_rc" -eq 2 ]]; then
  echo "错误: dsh web 进程在就绪前退出（可能端口被占/EADDRINUSE/插件加载失败）——按上方 dsh 输出排查；--keep 可保留现场" >&2
  exit 1
elif [[ "$probe_rc" -eq 130 || "$probe_rc" -eq 143 ]]; then
  # 用户在探测期间 Ctrl+C（SIGINT/SIGTERM 同时送达探测进程与 dsh）：静默走清理
  exit "$probe_rc"
else
  echo "错误: dsh web 15s 内未就绪（端口 $PORT）——按上方 dsh 输出排查；--keep 可保留现场" >&2
  exit 1
fi
# 10. 前台等待：dsh 退出（含 Ctrl+C）后 EXIT trap 统一清理
wait "$DSH_PID"
