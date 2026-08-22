# dsh-upgrade 命令谱（references）

本文件是 [SKILL.md](../SKILL.md) 各阶段的**可直接复制的命令配方**。所有路径均为本机真实路径；`workdir` 替换为实际目录。

---

## A. 基线与目标发现（S0）

```bash
# 当前 dsh 版本 + 已装依赖
dsh --version
cat ~/.local/node/lib/node_modules/@deepseek-ai/dsh/package.json | node -e "const p=require('/dev/stdin');console.log('version',p.version);console.log('deps',Object.keys(p.dependencies).filter(k=>k.startsWith('@deepseek-ai')||k==='cordis'||k==='schemastery'||k.includes('react')).length)"

# 目标 rc 发现（latest 可能滞后，升级要显式 pin）
npm view @deepseek-ai/dsh versions --json
npm view @deepseek-ai/dsh dist-tags --json

# 目标 rc 的依赖清单（过滤 dsh/cordis/schemastery/react）
npm view @deepseek-ai/dsh@<target> dependencies --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const d=JSON.parse(s);for(const[k,v]of Object.entries(d)){if(/^@deepseek-ai\/dsh-|cordis|schemastery|react/.test(k))console.log(k+'@'+v)}})"

# profile 插件清单（区分 link / 版本化 / github-pin）
cat ~/.dsh/profiles/web/package.json | node -e "const p=require('/dev/stdin');console.log('deps',JSON.stringify(p.dependencies,null,2));console.log('bundles',JSON.stringify(p.dsh.profile.bundles,null,2))"
```

---

## B. 编译 lib 比对（S1/S3 的权威兼容性信号）

> 原理：版本号全量升 rc ≠ 破坏性；**比对已装 lib/ 与目标 rc 的 lib/** 才是证据。

```bash
SRC=~/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai
mkdir -p /tmp/dsh-rc-check && cd /tmp/dsh-rc-check

# 对插件消费的每个 dsh 包，逐一比对
for pkg in dsh-settings dsh-tools dsh-client-runtime dsh-client-connection dsh-client-ui-slots; do
  npm pack "@deepseek-ai/$pkg@<target>" --silent >/dev/null 2>&1
  rm -rf rcX/$pkg && mkdir -p rcX/$pkg
  tar -xzf deepseek-ai-$pkg-<target>.tgz -C rcX/$pkg 2>/dev/null
  echo "===== $pkg : installed(rc.old) vs <target> ====="
  if [ -d "$SRC/$pkg/lib" ]; then
    diff -rq "$SRC/$pkg/lib" rcX/$pkg/package/lib 2>/dev/null && echo "(lib 完全一致)"
  else echo "(本地无 $pkg)"; fi
done

# 只看导出面（判断是否删除/破坏签名）
grep -oE "export (const|function|class|async function) [A-Za-z0-9_]+|export \{[^}]*\}" "$SRC/<pkg>/lib/index.js"
grep -oE "export (const|function|class|async function) [A-Za-z0-9_]+|export \{[^}]*\}" rcX/<pkg>/package/lib/index.js
```

判定：完全一致 / 仅追加导出 / 仅注释 → 安全；导出面删除或签名破坏 → 破坏性。

---

## C. git tag 比对（S1，有 deepseek-harness clone 时）

```bash
cd <deepseek-harness clone>
git fetch --tags origin                                  # 取目标 rc tag（dsh-v0.1.0-rc.8）
git diff --stat dsh-v0.1.0-rc.7 dsh-v0.1.0-rc.8         # 看规模，区分前端/验证工具 vs 运行时
git diff --stat dsh-v0.1.0-rc.7 dsh-v0.1.0-rc.8 -- packages/<dir>   # 只看插件消费的包目录
git log --oneline dsh-v0.1.0-rc.7..dsh-v0.1.0-rc.8 | grep -iE "breaking|migrat"  # 破坏性说明（常无）
```

---

## D. link 插件消费面映射（S3）

```bash
cd <dsh-plugin-hub clone>
# 每个插件的 client.inject 注入项
for p in dsh-gzip dsh-idle-archive dsh-lan-proxy dsh-mcp-manager dsh-notifier dsh-opencode-usage dsh-web-file-preview; do
  echo "--- $p ---"
  node -e "const p=require('./packages/$p/package.json');console.log(JSON.stringify(p.dsh&&p.dsh.client&&p.dsh.client.inject||[]))"
done
# 全部 src/shared/client 中对 dsh/cordis/schemastery 的 import
grep -rhoE "from ['\"](@deepseek-ai/[a-z0-9-]+|cordis|schemastery|cosmokit)['\"]|import\(['\"](@deepseek-ai/[a-z0-9-]+)['\"]" packages/*/src packages/*/shared packages/*/client 2>/dev/null | sort | uniq -c | sort -rn
```

---

## E. github-pin 插件调查（S2）

```bash
# 解析真实仓库（@dsh-external/xxx 只是 pnpm 别名，非 npm 包）
grep -n "dsh-mobile-nav\|dsh-web-mobile" ~/.dsh/profiles/web/package.json
# → "github:mexiaosqwq/dsh-web-mobile#v1.0.0"

# 仓库本体 + 是否 fork（parent）
gh repo view mexiaosqwq/dsh-web-mobile --json nameWithOwner,description,isFork,parent,licenseInfo
# 全部 tag / release（看是否有更新）
gh api repos/mexiaosqwq/dsh-web-mobile/tags
gh api repos/mexiaosqwq/dsh-web-mobile/releases
# 目标 tag 的 peerDependencies（校验是否兼容目标 rc）
gh api repos/mexiaosqwq/dsh-web-mobile/contents/package.json?ref=v1.5.0 | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);const p=JSON.parse(Buffer.from(j.content,'base64').toString());console.log('peerDeps',JSON.stringify(p.peerDependencies||{}))})"
```

> 注意：github-pin 插件的 peer 如 `@deepseek-ai/dsh-client-*@^0.1.0-rc.6`，semver caret+prerelease 下**包含** rc.8（同 base 0.1.0），故目标 rc 满足。

---

## F. 升级/回滚命令（S4，均交用户执行）

```bash
# Phase 0 备份
cp ~/.dsh/profiles/web/package.json          ~/.dsh/profiles/web/package.json.bak-rcN
cp ~/.dsh/settings.yaml                     ~/.dsh/settings.yaml.bak-rcN
cp ~/.dsh/profiles/web/pnpm-lock.yaml        ~/.dsh/profiles/web/pnpm-lock.yaml.bak-rcN

# Phase 1 升 dsh CLI（显式 pin；latest 仍是旧 rc）
npm i -g @deepseek-ai/dsh@<target>
dsh --version

# Phase 2 改 pin（dsh plugin 转发 pnpm，会改 package.json + 重装；不手编）
dsh plugin --profile web add @dsh-external/dsh-mobile-nav@github:mexiaosqwq/dsh-web-mobile#v1.5.0
dsh plugin --profile web install
dsh plugin --profile web list

# Phase 3 重启 dsh web —— 用户本人执行，Agent 不得 kill/重启

# Phase 4 冒烟
dsh plugin --profile web list
# 浏览器：DevTools Console 无 client-runtime/connection 加载错误；各插件加载；
# 窄屏（iPad/iOS）实测移动端插件（mobile-nav）。

# Phase 5 升版本化插件（dsh 稳定后）
dsh plugin --profile web add @linxin666/dsh-client-ui-skill-explorer@0.2.5
dsh plugin --profile web install

# 回滚
npm i -g @deepseek-ai/dsh@<prev>
cp ~/.dsh/profiles/web/package.json.bak-rcN   ~/.dsh/profiles/web/package.json
dsh plugin --profile web install
# 然后用户重启 dsh web
```

---

## G. 冒烟检查清单（Phase 4）

- [ ] `dsh --version` 显示目标 rc
- [ ] `dsh plugin --profile web list` 各插件版本/pin 符合预期
- [ ] 浏览器 Console 无 `client-runtime` / `client-connection` 加载错误
- [ ] 7 个 link 插件均加载（MCP 浮窗、notifier、lan-proxy、idle-archive、opencode-usage、gzip、web-file-preview）
- [ ] 版本化插件仍正常：skill-explorer、archify-dsh、smooth-stream、mobile-nav
- [ ] **窄屏实测（最关键）**：iPad / iOS 访问，验证 mobile-nav 抽屉/侧栏适配
- [ ] 明暗双主题下插件 UI 正常（不硬编码配色）
