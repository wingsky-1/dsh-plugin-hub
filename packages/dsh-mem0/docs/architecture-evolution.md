# dsh-mem0 长期记忆系统全生命周期架构演进全纪录

> 本文档为 [issue #590](https://github.com/wingsky-1/dsh-plugin-hub/issues/590) 的落地交付物，永久记录 `@wingsky-1/dsh-mem0`（DeepSeek Harness 长期记忆系统插件）从阶段一 MVP 到阶段三演进方向的完整架构脉络、对抗性审查与决策全过程。

---

## 一、阶段一：基于 Python stdio 的 MCP 基础骨架（PR #573）

### 1.1 架构决策：进程隔离而非进程内嵌入

| 备选方案 | 裁决 | 理由 |
|---|---|---|
| Node 进程内直接 import mem0ai | 否决 | mem0ai 为 Python 生态库，无对等 TS 实现可满足事务性存储需求（见阶段二对 mem0-ts 的否决） |
| 常驻 sidecar 容器 | 否决 | 脱离个人开发者开箱即用诉求，引入容器编排负担 |
| **本地 Python stdio 子进程（采用）** | ✅ | 与 DSH Web 父进程同生共死；零外部端口、零端口冲突；管道通信天然隔离 |

### 1.2 核心交付

1. **Git Canonical 命名空间自动感知**（`src/namespace.ts`）：原生提取会话 `cwd`，经 `git-common-dir` 与 `remote.origin.url` 将主仓与全部 worktree 映射至统一命名空间（`proj:<owner>/<repo>`），跨分支共享同一份记忆；非 Git 目录回落 `global`。
2. **全英文工具契约与熔断**（`src/tool-definitions.ts`）：`memory_search` / `memory_add` / `memory_list` / `memory_delete` 四工具全英文 schema；`isReady()` 状态门禁，服务离线时返回结构化降级提示，绝不抛未捕获异常。
3. **会话级单次提示词注入**（`src/prompt.ts`）：`agent/pre-step` 钩子单会话幂等注入 ≤50 tokens 记忆纪律。

---

## 二、阶段二：红队逆向审视、架构定案与全面配置化（PR #578 / #582 / #588）

### 2.1 三大陷阱的对抗性审视与否决（红队评审结论）

#### 2.1.1 否决官方 `mem0-ts` 库接入

对 `mem0ai@3.x`（mem0ai/oss）发行物源码深度逆向后的结论：

- **构建不可行**：40+ 种后端暴力打包在单一发行文件中，顶层静态硬编码 `import Database from "better-sqlite3"`——C++ 原生动态模块（Native Addon）无法通过 esbuild 自包含内联门禁（违反本仓「发布物自包含」红线）；
- **语义缺陷**：`add(..., { infer: false })` 还原快照会触发对每条已有记忆的真实远程 Embedding HTTP 请求（冷启动 API 刷量风暴与限流）；硬编码 `v4()` 导致记忆 ID 彻底漂移，跨版本不可迁移。

#### 2.1.2 否决手写轻量 JSONL 存储

记忆系统的灵魂在于**覆盖更新（UPDATE）与废弃删除（DELETE）**。在无事务保证的 JSONL 上实现改写：

- 全量原地重写在并发场景下极易发生**文件撕裂（File Tearing）**；
- 手写墓碑（Tombstones）与 Compaction 等于粗制滥造发明一个充满并发缺陷的劣质数据库。

**裁决**：坚持 Python 端 mem0ai 完整栈（Qdrant local 模式 + FastEmbed + LLM 提炼管线），Node 端只做进程编排与工具封装——让专业数据库管存储，不重复造轮子。

#### 2.1.3 否决 Qdrant 远程容器依赖（保留 local 内嵌模式）

要求个人开发者为几句偏好先跑一个 Docker 容器属脱离群众的过度设计。默认 `QDRANT_PATH` 本地内嵌落盘（`~/.dsh/mem0/data/qdrant`），同时保留 `QDRANT_HOST` 环境变量对重度用户的远程升级通道。

### 2.2 已落地成果

#### PR #578 / #582（阶段二主体）

| 能力 | 实现要点 |
|---|---|
| 本地零费用向量默认 | `fastembed` 引擎 + `BAAI/bge-small-zh-v1.5`（512 维），纯 CPU ~5ms，零网络零密钥开箱即用 |
| Web「记忆中心」双区大盘 | 记忆列表 + 引擎配置双子 Tab；模型消耗卡片实时提示 |
| 全面配置化 | 接入 DSH 官方 `installSettingsNamespace`（`~/.dsh/settings.yaml`）；`sk-***` 掩码回显；非对称合并保存（防掩码写穿真实密钥）；配置变更触发引擎热重载 |
| 环境双重自愈 | `src/venv-manager.ts` 探测依赖完备性；优先专属 venv（`~/.dsh/mem0/venv`）；`ensurepip` 缺失时平滑转 `pip install --user` 免提权安装；阿里云镜像源加速 |
| 100% i18n | zh/en 字典 1:1 镜像断言 + 源码硬编码中文正则扫描双护栏 |

#### PR #588（#588：LLM 复用与向量精简，阶段二收官）

| 能力 | 实现要点 |
|---|---|
| LLM 双模式 | `llmMode=dsh`（复用 DSH 全局 provider/model）与 `custom`（自填端点）切换 |
| 凭据静默解析 | `src/provider-resolver.ts`：DSH 凭据 Seam（`listConfigurableProviders` → settings → `credentials.resolve`）→ 环境变量 → `.credentials.yaml` 多层兜底；**真实 Key 仅存在于 Node 宿主端与 Python 子进程环境，绝不回传前端** |
| 动态级联拉取 | `GET /api/dsh-mem0/llm-providers` 与 `llm-models?provider=` loopback 只读路由；`ctx.llm.listProviders()/listModels()`；5s 超时竞速 + 60s 服务端 TTL 缓存 + `pending.catch` 未处理拒绝拦截 |
| 内置 Provider 兜底映射 | deepseek / openai / siliconflow / moonshot / zhipu / glm / groq / openrouter / ollama 默认 Base URL 映射，防配置缺失时误打外网默认端点 |
| 向量模型精简分流 | 本地模式严格收敛为 3 档验证过的轻量模型（bge-small-zh 512d 默认 / paraphrase-multilingual-MiniLM 384d 超轻量 / multilingual-e5-large 1024d 高精）；远程模式自由文本 + 自定义维度；硬件消耗徽章（内存常驻 / CPU 延迟 / 维度 / 零费用）流式展示 |
| Qdrant 维度动态隔离 | 集合名 `mem0_v2_dim_{dims}` 绑定向量维度，不同维度模型拥有独立向量空间，彻底杜绝切换模型后的 `Wrong input vector dimension` 崩溃 |
| 客户端 TSX 迁移 | `MemoryCenter.tsx` 原生 TSX 重写（#584 阶段二续），react-shim 对齐 #605 已验证形态 |

### 2.3 关键踩坑记录

1. **TS7 JSX 全局合并形态**：`react-shim.d.ts` 中 `declare global { namespace JSX }` 包裹层在 TS7 `--jsx react` 下**不会**与全局 JSX 合并（TS7026）；必须采用模块内裸 `namespace JSX` 形态（与 #605 dsh-lan-proxy 已验证写法一致）。
2. **schemastery 字面量联合类型**：`z.string().default()` 推导 `string`，与接口中 `"dsh" | "custom"` 字面量类型不兼容（TS2322）；解法为接口类型面放宽 `string` + `mergeConfigPatch` 运行时白名单校验收窄。
3. **React any shim 与 hooks 泛型**：shim 的 `React: any` 使 `useState<T>()` 泛型调用非法（TS2347），客户端组件应省略 hooks 泛型、lambda 参数显式 `: any`。

---

## 三、阶段三演进规划（issue #581 已立项）

1. **会话首轮智能预检索与上下文动态注入**：会话首轮对用户 prompt 触发 5ms 本地静默向量匹配，高相关时注入带防御围栏的记忆块，消灭首轮 `memory_search` 工具往返（提速 2~4s）。
2. **自动被动记忆提取**：交互间歇后台异步分析对话，自动提炼沉淀用户技术偏好与架构决策。
3. **生态合流与发布**：经 `scripts/gate/aggregate.ts` 将 `dsh-mem0` 纳入 `dsh-plugins-all` 聚合包，随正式版本发布。
