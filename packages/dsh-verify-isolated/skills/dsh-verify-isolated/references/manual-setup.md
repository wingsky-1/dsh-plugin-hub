# 手动搭建隔离环境（脚本的等价展开）

> 读它的时机：一键脚本不可用（无法运行 node 脚本、dsh 入口异常）、要理解脚本每一步在
> 做什么、或要手工调整某一层隔离。日常验证直接用 `scripts/verify-isolated.mjs`，
> 见 SKILL.md §2。

```bash
# 工作目录：被测插件所在的仓库（SKILL_BASE 取注入的「Base directory for this skill:」绝对路径）
# 1. 第一层隔离：全新临时 DSH_HOME
DSH_HOME=$(mktemp -d)
export DSH_HOME

# 2. 第二层隔离：独立 profile（verify_<8位随机>，避免与真实环境冲突）
PROFILE="verify_$(node -e 'console.log(require("node:crypto").randomBytes(4).toString("hex"))')"
dsh plugin --profile "$PROFILE" list >/dev/null   # 显式初始化 profile（含 dsh-base 模板；失败即停）

# 3. 注入内置 web-app bundle：@deepseek-ai/dsh-base、@deepseek-ai/dsh-web-app 按名
#    从 dsh 安装目录解析，不进 dependencies、不走 npm
node -e '
  const fs = require("fs");
  const p = process.argv[1];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  const b = j.dsh.profile.bundles;
  if (!b.includes("@deepseek-ai/dsh-web-app")) {
    b.splice(b.indexOf("@deepseek-ai/dsh-base") + 1, 0, "@deepseek-ai/dsh-web-app");
  }
  fs.writeFileSync(p, JSON.stringify(j, null, 2));
' "$DSH_HOME/profiles/$PROFILE/package.json"

# 4. 挂载本地插件（被测插件目录，link 进 profile）
dsh plugin --profile "$PROFILE" add /path/to/your-plugin-package

# 5. 预置首启弹窗跳过（等价于脚本默认行为；要验证弹窗本身时跳过本步）：版本号取自
#    dsh 客户端产物的 WELCOME_NOTICE_VERSION（精确相等才算已确认），故用脚本同源的
#    探测函数现取——凭记忆写会在 dsh 升级后让弹窗重新出现，且不报任何错
WELCOME_V=$(node -e 'import(process.argv[1]).then((m) => console.log(m.findWelcomeNoticeVersion(process.argv[2])?.version ?? ""))' \
  "$SKILL_BASE/scripts/lib/onboarding.mjs" "$(command -v dsh)")
test -n "$WELCOME_V" || echo "警告: 未取到版本号——内测声明弹窗由 browser-driver 兜底跳过"
printf 'ui-onboarding:\n  welcomeNoticeVersion: %s\n' "$WELCOME_V" > "$DSH_HOME/settings.yaml"

# 6. 启动隔离 dsh web（指定不冲突端口；--port 0 让系统随机；显式回环 + 遥测禁用）
DSH_TELEMETRY_DISABLED=1 dsh --profile "$PROFILE" --host 127.0.0.1 --port 3456 --no-open

# 7. 就绪断言（对齐脚本行为）：轮询 HTTP 可达再开始验证（GUI 带鉴权，2xx-4xx 均算就绪；
#    连接拒绝继续等，15s 超时报错）
node -e 'const t=Date.now();(async()=>{for(;;){try{const r=await fetch("http://127.0.0.1:3456/",{signal:AbortSignal.timeout(1500)});if(r.status<500)break}catch{}if(Date.now()-t>15000)throw new Error("15s 未就绪");await new Promise(r=>setTimeout(r,250))}})()'

# 8. 取带访问令牌的访问 URL：dsh 启动打印的 `dsh web: http://...?token=...` 即 GUI 的
#    唯一可用入口；裸端口只会返回 401 文本页
DSH_WEB_URL=$(grep -o 'dsh web: http://[^ ]*' "$DSH_HOME/dsh.log" | tail -1 | sed 's/^dsh web: //')
echo "$DSH_WEB_URL"   # 后续 browser-driver 命令用 --url "$DSH_WEB_URL"
```

需要浏览器实例时（第四层隔离，等价于脚本 `--browser`）：

```bash
node "$SKILL_BASE/scripts/browser-driver.mjs" launch \
  --state "$DSH_HOME/browser.state" --user-data-dir "$DSH_HOME/browser-profile"
# 退出前清理（与脚本统一清理相同语义）：
node "$SKILL_BASE/scripts/browser-driver.mjs" quit --state "$DSH_HOME/browser.state"
```

收尾：停止隔离 `dsh web` 进程后删除临时目录（`rm -rf "$DSH_HOME"`），避免残留无用的
`verify_*` profile。脚本模式会自动做这件事。
