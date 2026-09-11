# 工业级变异测试全链路优化与落地指南

> 本指南总结沉淀了大型 TypeScript / Node.js Monorepo 变异测试（Mutation Testing）的工业级全链路优化体系。
> 涵盖：运行与计算加速、独立孤立分支基线存储（Orphan Branch）、PR 产物秒级差量覆盖（Overlay 机制）、单一事实源拓扑清单与代码生成（SSOT + CodeGen），以及防漏测硬门禁。

---

## 1. 背景与三大核心痛点

变异测试（Mutation Testing）通过向被测源码中注入微小的逻辑变异（Mutant，如颠倒条件、替换运算符、修改返回值），来检验单元测试套件能否准确“杀灭”变异，是衡量测试有效性与代码质量的终极防线。

但在大型工程落地中，变异测试通常面临三大致命痛点：
1. **执行过于缓慢（Wall-clock 瓶颈）**：单个包数千个 Mutant，全量测试通常需要 15~30 分钟，无法作为 PR 提交时的快速门禁；
2. **代码仓库严重膨胀（存储与噪音痛点）**：若采用增量变异，数十万行的基线 JSON 文件提交进主分支，会导致 Git 历史迅速膨胀、日常 PR 列表中充斥着机器人的巨额 diff；
3. **分段配置繁琐易错（维护与假高分隐患）**：为了并发将大包切成多个分段，导致大量雷同的配置文件产生；若新增源文件未配置变异段，下游聚合判分时分母缩小，反而会产生**“漏测导致的假高分”**。

---

## 2. 架构总览与全景拓扑

本方案将变异测试拆解为四个紧密协同的子系统：

```text
  ┌────────────────────────────────────────────────────────────────────────┐
  │ 1. 配置治理层 (SSOT + CodeGen)                                         │
  │    scripts/data/mutation-topology.json (单一事实源)                    │
  │      └── 自动派生全套 stryker.conf.d/*.json + 全源文件覆盖防漏测硬门禁   │
  └───────────────────────────────────┬────────────────────────────────────┘
                                      │ 驱动
  ┌───────────────────────────────────▼────────────────────────────────────┐
  │ 2. 计算与运行加速层 (Execution Acceleration)                           │
  │    • mutate 直连 src (绕过 bundle 行号漂移)                             │
  │    • Node 24 compile cache (-41% TS 动态转译开销)                      │
  │    • Concurrency 超订分级 (纯单元测试 16 并发 / 有状态测试 4 并发)      │
  │    • 裁剪非逻辑变异 (String/Template/Array/ObjectLiteral)              │
  └───────────────────────────────────┬────────────────────────────────────┘
                                      │ 增量比对
  ┌───────────────────────────────────▼────────────────────────────────────┐
  │ 3. 增量基线存储层 (Orphan Branch + Overlay)                            │
  │    • 独立孤立分支 refs/heads/baseline/mutation (历史深度恒为 1)         │
  │    • 纯文本 JSON 树存储 (享受 Git Blob 内容寻址 0 空间增量)             │
  │    • PR 门禁：git fetch 毫秒级恢复，穿透 Fork PR 零权限要求            │
  │    • PR 合并：baseline-overlay 15 秒差量覆盖强推，合入免跑变异测试     │
  └────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 第一支柱：计算与运行层加速（算力减负）

变异测试是典型的 CPU 密集型任务。优化必须首先从降低单次运行的物理开销切入：

### 3.1 变异目标直连源码（Direct-to-Src）
* **原理**：传统变异测试针对构建产物（`lib/index.js`），编译打包造成的代码混淆和行号位移会导致增量指纹极易失效，且每次测试都需前置全量 build。
* **做法**：测试用例中保持正常的包入口引用（`import "../lib/index.js"`），但在 Stryker 运行时通过 Node `--import hook`（如 `mutation-lib-to-src-hook.mjs`）在模块解析（`nextResolve`）阶段动态将 `packages/<pkg>/lib/**` 重定向到 `packages/<pkg>/src/**.ts`。
* **收益**：Mutant 指纹直接锚定在 `.ts` 源码 AST 上，源码局部修改绝不引发跨文件指纹漂移。

### 3.2 注入 Node.js 编译缓存（Compile Cache）
* **原理**：Stryker 的并发 Sandbox 在执行测试时，会反复拉起独立 Node 进程动态转译 TypeScript 源码。
* **做法**：在测试运行器的 Bridge 脚本（如 `mutation-tap-bridge.cjs`）最头部注入：
  ```javascript
  // Node >= 24.12 支持
  try {
    const { enableCompileCache } = require('node:module');
    if (typeof enableCompileCache === 'function') enableCompileCache();
  } catch {}
  ```
* **实测收益**：将 TS 动态编译加载开销**直接削减 41%**，单任务倍率从 $\times 1.47$ 压低至 $\times 1.10$。

### 3.3 Concurrency 超订分级评估
不要在所有包上盲目使用同一并发数，应按测试用例的资源形态分级治理：
* **可直升 16 并发**：纯内存算法、无端口绑定、无全局单例的模块；
* **维持 4 并发**：存在固定端口监听、跨进程 Socket 或真实文件系统独占锁的模块（防止高并发端口冲突导致抛出异常，被 Stryker 误判为“杀灭 Mutant”从而虚增假高分）；
* **收紧 Timeout**：默认将单用例超时收紧到 15s~30s（防止死循环 Mutant 拖垮全局时长）。

### 3.4 裁剪非核心变异算子（Excluded Mutations）
变异测试的核心是检验分支判定与业务逻辑。排除不影响控制流的纯文字/字面量类变异：
```json
"mutator": {
  "excludedMutations": [
    "StringLiteral",
    "TemplateLiteral",
    "ArrayLiteral",
    "ObjectLiteral"
  ]
}
```
* **收益**：立减 30%~50% 无意义的字符串/数组变异，Mutant 质量聚焦在条件分支、布尔逻辑与边界操作符上。

---

## 4. 第二支柱：增量基线存储与传输（彻底移出主分支）

### 4.1 传统方案的缺陷对比
| 方案 | 机制 | 致命暗礁 |
| :--- | :--- | :--- |
| **GitHub Actions Cache** | `actions/cache` 保存基线 | **不可行**。GitHub 安全模型强制按 Ref 隔离，**来自外部 Fork 的 PR 命中率恒等于 0%**，全部退化为全量长尾测试。 |
| **主分支提交 JSON 文件** | 直接提交到 `main` 分支代码树 | **不可行**。每次更新产生 8~16 万行 JSON diff，主分支充斥大量机器人 PR，Git 历史迅速膨胀数 GB。 |
| **打包为 `tar.gz` 强推** | 压成单一二进制包推分支 | **不可行**。Git 对二进制压缩包的 Delta 差量压缩率为 0，高频推送旧 Blob 无法被 GC，一年产生近 10GB 游离垃圾。 |

### 4.2 最优解：独立孤立分支（Orphan Branch）存储纯文本树（形态 A）
* **存储位置**：设立专用的孤立引用 `refs/heads/baseline/mutation`；
* **单 Commit 纯快照（深度恒为 1）**：
  生成 Commit 时**不声明父节点**（无 `-p` 参数），每次提交生成一个完全独立的单快照并以 `git push --force` 强推覆写。
  - 分支历史在 Git 提交图谱中永远只有 1 个最新的 Commit，杜绝历史链条堆叠。
* **纯文本存储解开的 JSON**：
  直接存储 `incremental-*.json` 与 `manifest.json`，不使用 tar.gz 打包。
  - 充分利用 Git 底层基于内容寻址（Content-Addressable）的去重优势。未变动的文件其 Blob SHA 完全一致，**Git 服务端空间开销为 0**；变动的文件享受极高压缩比的纯文本差量压缩。

### 4.3 PR 门禁极速拉取（零权限、零 API 依赖）
在 PR 门禁阶段：
```bash
# 1. 浅拉取孤立分支（仅需 200~300ms）
git fetch --depth=1 origin refs/heads/baseline/mutation:refs/remotes/origin/baseline/mutation

# 2. 从远端 commit 对象中提取基线文件（无需 checkout 分支，不脏工作区）
git show origin/baseline/mutation:incremental-<pkg>.json > coverage/mutation/incremental-<pkg>.json
```
* **核心优势**：纯 Git 协议原生拉取，**不需要任何 GitHub Token 权限**，外部社区贡献者 Fork 提 PR 也能毫秒级读取，永不撞 GitHub REST API 速率限制。

---

## 5. 第三支柱：合入秒级差量覆盖（Overlay 机制）

### 5.1 业务时序与“零冗余计算”
PR 在提测门禁时，已经对改动的代码跑过一遍变异测试了。代码合并入 `main` 分支后，**绝不应该再重新跑一次耗时的变异测试**！

```text
[开发者提 PR]
   │
   ▼
[PR CI (mutation-gate)] ───── 运行变异测试（仅改动包） ────► 上传 mutation-incremental-* 产物
                                                                    │
                                                            PR Squash Merge
                                                                    │
[main 分支 push 触发] ──────► baseline-overlay.yml 启动 (耗时仅 10~15 秒，零 Stryker 计算！)
                              ├─ 1. 通过 GitHub API 权威反查本次合并的 PR 及其 CI Run
                              ├─ 2. 若为纯文档/未触及变异切片的 PR，3 秒内优雅识别并 No-op 跳过
                              ├─ 3. 若有变异产物：
                              │     ├─ 从孤立分支 baseline/mutation 恢复全集基线
                              │     ├─ 下载本次 PR 产出的几个最新 incremental JSON
                              │     ├─ 严格校验 JSON 合法性，覆盖同名文件
                              │     └─ 重新计算 manifest.json 哈希
                              └─ 4. Git plumbing (mktree -> commit-tree) 强推孤立分支
```

### 5.2 核心脚本：`scripts/gate/overlay-baseline.mjs`
核心实现范式（已封堵路径穿越与数据投毒）：
```javascript
import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const repo = process.env.GITHUB_REPOSITORY;
const commitSha = process.env.COMMIT_SHA;
const BRANCH = 'baseline/mutation';

// 1. 反查合并的 PR 与成功的 CI Run
const pulls = JSON.parse(runGh(['api', `repos/${repo}/commits/${commitSha}/pulls`]));
const pr = pulls.find(p => p.merged_at);
if (!pr) process.exit(0); // 非 PR 合并，优雅跳过

const runs = JSON.parse(runGh(['api', `repos/${repo}/actions/runs?head_sha=${pr.head.sha}&event=pull_request&status=completed`, '--jq', '.workflow_runs']));
const ciRun = runs.find(r => r.name === 'CI' && r.conclusion === 'success');
if (!ciRun) process.exit(0);

// 2. 检查是否有变异产物
const artifacts = JSON.parse(runGh(['api', `repos/${repo}/actions/runs/${ciRun.id}/artifacts`, '--jq', '.artifacts']));
const mutArtifacts = (artifacts || []).filter(a => a.name.startsWith('mutation-incremental-'));
if (mutArtifacts.length === 0) {
  console.log('[Overlay] 纯文档/配置改动，无变异产物，安全跳过 (No-op)');
  process.exit(0);
}

// 3. 隔离工作区拉取旧基线并覆写
const tmpWork = mkdtempSync(join(tmpdir(), 'dsh-overlay-'));
const baselineDir = join(tmpWork, 'baseline');
mkdirSync(baselineDir, { recursive: true });

// 恢复孤立分支基线树...
// 逐个下载 mutArtifacts，校验 JSON 格式后写回 baselineDir...

// 4. 重算 manifest.json 并通过 plumbing 构建单 Commit 树
const treeSha = runCmd('git', ['mktree'], { input: mktreeLines });
const commitShaNew = runCmd('git', ['commit-tree', treeSha, '-m', `chore(baseline): overlay incremental from PR #${pr.number} [skip ci]`]);
runCmd('git', ['push', '--force', remoteTarget, `${commitShaNew}:refs/heads/${BRANCH}`]);
```

### 5.3 并发互斥锁配置
在 `.github/workflows/baseline-overlay.yml` 中配置：
```yaml
concurrency:
  group: mutation-baseline-sync
  cancel-in-progress: false  # 必须排队执行，彻底杜绝多次快速 Merge 导致覆盖丢失 (Lost Update)
```

---

## 6. 第四支柱：配置治理与分段优化（SSOT + CodeGen + 防漏测）

### 6.1 为什么必须保留物理分段？
* 本地实测表明：大型包（如包含 15~25 个文件、2500+ Mutant）若单任务全量冷启动，耗时在 **4~8 分钟**；
* 通过拆分为 4~6 个分段，利用 GitHub Actions 并行矩阵展开，Wall-clock 等待时间被**稳定拉平在 1~2 分钟内**。

### 6.2 为什么不能用“运行时动态贪心分桶（Auto-Sharding）”？
* 动态分桶对微小改动极度敏感。开发者改动 3 行代码，可能导致排序重排，文件被踢入不同的桶中；
* 跨分片的文件在旧基线中无记录，**引发全仓 100% 增量基线击穿（Cache Storm）**，耗时从 20 秒恶化到数分钟；
* 失去静态事实源，一旦脚本过滤漏测某个模块，下游聚合时分母缩小，产生**“假高分”质量黑洞**。

### 6.3 最佳实践：单一拓扑清单（SSOT） + 代码生成（CodeGen）
* **集中维护**：创建 `scripts/data/mutation-topology.json`，收敛全仓共享模板与各包分段定义：
  ```json
  {
    "sharedDefaults": {
      "testRunner": "tap",
      "concurrency": 16,
      "timeoutMS": 60000,
      "dryRunTimeoutMinutes": 5,
      "coverageAnalysis": "perTest",
      "excludedMutations": ["StringLiteral", "ArrayLiteral", "ObjectLiteral", "TemplateLiteral"],
      "tapNodeArgs": [
        "-r", "./scripts/test/mutation-tap-bridge.cjs",
        "--import", "./scripts/test/mutation-lib-to-src-hook.mjs"
      ]
    },
    "$testLayers": {
      "layers": {
        "unit": "test/unit/**/*.test.ts",
        "integration": "test/integration/**/*.test.ts"
      },
      "mutationLayers": ["unit", "integration"]
    },
    "packages": {
      "dsh-provider-usage": {
        "concurrency": 16,
        "timeoutMS": 60000,
        "segments": {
          "apply": { "mutate": ["packages/dsh-provider-usage/src/apply.ts"] },
          "contracts": { "mutate": ["packages/dsh-provider-usage/src/contracts.ts", "packages/dsh-provider-usage/src/core/guards.ts"] }
        }
      }
    }
  }
  ```
* **一键代码生成工具**：`scripts/gate/gen-stryker-conf.mjs`（#690 S2b 起由「测试层 glob」派生
  `tap.testFiles`，不再是包级手写数组——手写清单已经漂移过 5 个单元文件）
  - `pnpm stryker:gen`：派生生成全部 `stryker.conf.d/*.json` 配置文件；
  - `node scripts/gate/gen-stryker-conf.mjs --sync-test-min`：把各包 `--min` 同步为实际测试文件数；
  - `pnpm stryker:check`：门禁校验三件事——磁盘文件与清单 100% 逐字一致、每个 `test/` 下
    `*.test.ts` 都有层归属、各包 `--min` == runner glob 实际文件数。
* **全源文件覆盖强制断言（Anti-Silent-Drop）**：
  `scripts/gate/verify-dir-imports.mjs` 扫描全仓业务源码，断言
  **`packages/<pkg>/src` 下每个文件都落在 `∪mutate ∪ ∪excludes` 之内**（excludes 含段级
  默认值与包级 `testLayers.coverageExcludes` 的存量登记，见 `scripts/gate/mutation-topology.mjs`）。
  只要新增业务代码却忘记配置变异分段或显式登记排除，门禁直接报错阻断。
  覆盖断言的存量缺口存在 `scripts/data/dir-imports-baseline.json` 的 `uncoveredSrcFiles`，
  **只许减不许增**；#690 S2b 已把 24 个门面/声明/资源类存量清空为 0。

---

## 7. 跨项目实施与迁移 Checklist

若要在另一个项目中落地本方案，可按以下标准步骤操作：

- [ ] **Step 1：孤立分支初始化**
  在目标仓库初始化孤立分支 `baseline/mutation`，推入初始的全量基线文件与 `manifest.json`（单 commit 深度为 1）。
- [ ] **Step 2：引入核心管理脚本**
  将以下两个通用脚本引入项目并适配：
  - `scripts/gate/orphan-baseline.mjs`（负责本地/CI 恢复 `restore` 与定时全量推送 `push`）
  - `scripts/gate/overlay-baseline.mjs`（负责合入主干时 15 秒差量覆盖 `overlay`）
- [ ] **Step 3：建立配置单一事实源**
  - 创建 `scripts/data/mutation-topology.json`；
  - 引入 `scripts/gate/gen-stryker-conf.mjs`；
  - 在 `package.json` 添加 `"stryker:gen"` 与 `"stryker:check"`。
- [ ] **Step 4：改造工作流编排**
  - `ci.yml`：变异测试通过后上传 `mutation-incremental-<pkg>-<seg>` artifact；
  - 新增 `.github/workflows/baseline-overlay.yml`（监听 `push: branches: [main]`）；
  - 定时调度工作流末尾改为调用 `orphan-baseline.mjs push`。
- [ ] **Step 5：代码树彻底瘦身**
  - 从主分支代码树删除所有历史基线 JSON，加入 `.gitignore` 保护或门禁断言；
  - 加入全源文件覆盖率断言（确保无漏测）。

---

## 8. 实施收益对照表

| 评估维度 | 传统常见方案 | 经过全链路优化后的方案 |
| :--- | :--- | :--- |
| **主分支代码树** | 充斥数十万行机器 JSON，巨额 Commit 膨胀 | **100% 纯净**，零基线文件，零机器人 PR |
| **PR 变异门禁耗时** | 10~20 分钟（或基线失效长尾卡死） | **常态 20~38 秒** 极速反馈 |
| **主干合入同步耗时** | 需重新串行运行变异（6~10 分钟） | **10~15 秒** 纯文件级差量覆盖，零算力浪费 |
| **Fork PR 兼容性** | 无法读取 Cache 导致 100% miss 降级全量 | **毫秒级 git fetch 恢复**，零权限要求 |
| **配置维护心智** | 手动维护数十个高度重复的 JSON | **单一清单集中维护**，一键生成，硬门禁防漏测 |
