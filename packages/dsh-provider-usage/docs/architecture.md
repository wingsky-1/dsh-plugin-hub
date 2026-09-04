# dsh-provider-usage 架构与运行机制（图解）

> 基于 v2 契约重构版源码（`src/index.ts` 及 `src/` 各模块）整理。
> 本文用流程图 / 时序图讲清三件事：**整个插件怎么跑起来、自定义适配器怎么注入、客户端与服务端怎么交互**。
> 配套文档：适配器开发引导见 [adapter-guide.md](adapter-guide.md)；快速上手见 [../README.md](../README.md)。

---

## 1. 总体架构：一次渲染，两端分工

v2 的核心设计是**宿主端渲染**：用户适配器在 Node 侧产出 HTML，浏览器端只做「拉数据 + 注入 DOM」，不再维护任何渲染器注册表（v1 的 `window.__DSH_USAGE__` 桥接已废弃）。

```mermaid
flowchart LR
    subgraph browser["浏览器（dsh web GUI）"]
        PILL["悬浮胶囊 dou-float<br/>60s 轮询 · capsuleHtml 注入"]
        PANEL["详情面板<br/>panelHtml 注入"]
        SETTINGS["设置页 tab「用量统计」<br/>settings.ts (React)"]
        PILL -->|点击展开| PANEL
    end

    subgraph host["宿主进程（dsh web · Node）"]
        ROUTES["7 条 HTTP 路由<br/>loopback 围栏 (403/405)"]
        GETSTATS["getStats()<br/>缓存 TTL + Mutex 互斥"]
        REG["AdapterRegistry<br/>候选 + 唯一启用"]
        PIPE["runV2Pipeline<br/>fetchData → formatCapsule → sanitize"]
        PIPEPANEL["runV2PanelPipeline<br/>query → formatPanel → sanitize"]
        HIST["HistoryStore<br/>按天分片 JSONL"]
        HOT["HotReloadableAdapter<br/>热更新换版"]
        WARM["预热定时器 5min"]

        ROUTES --> GETSTATS
        ROUTES --> PIPEPANEL
        GETSTATS --> REG
        GETSTATS --> PIPE
        GETSTATS --> HIST
        PIPEPANEL --> HIST
        HOT --> REG
        WARM --> GETSTATS
    end

    ADAPTER["用户适配器 .mjs<br/>fetchData / formatCapsule / formatPanel"]
    API["外部用量 API"]
    DISK[("持久化文件<br/>user-adapters.json / adapter-state.json<br/>historyDir/YYYY-MM-DD.jsonl")]

    PILL -->|"GET /stats"| ROUTES
    PANEL -->|"GET /history"| ROUTES
    SETTINGS -->|"GET /stats · adapters.json /<br/>select / inspect / add"| ROUTES
    PIPE -->|"apiEndpoint/apiKey 注入"| ADAPTER
    ADAPTER -->|"fetch()"| API
    HIST --- DISK
```

要点：

- **同一条链路，两个触发方**：客户端 60s 轮询和宿主端 5min 预热定时器都汇入同一个 `getStats()`；互斥锁保证任一时刻只有一个取数在飞。
- **适配器代码只活在宿主进程内**：密钥不进浏览器；HTML 在下发前经净化兜底。

---

## 2. 插件启动流程（`apply(ctx, config)`）

插件本身不改 DSH 源码——经 `cordis.patch.yml` + profile 机制挂载到 `dsh web`，`apply(ctx, config)` 在宿主启动时被调用。宿主端入口按固定顺序装配。任何一步失败都不阻断启动——适配器加载失败走 fail-fast 拒收并登记错误，其余功能照常。

```mermaid
flowchart TD
    S(["dsh web 启动<br/>cordis.patch.yml 挂载插件"]) --> A{"enabled === false ?"}
    A -->|是| Z0["不注册任何路由，直接返回"]
    A -->|否| B["normalizeConfig 归一化配置<br/>+ makeAdapterRegistry(路径脱敏)<br/>(钳制 warmup≥60s / cache≥5s / timeout 固定 5s 不可配置)"]
    B --> C["HistoryStore 就绪<br/>+ migrateLegacyV3 旧桶迁移(幂等)"]
    C --> D["register 内置 opencode-go<br/>(source=builtin，默认启用)"]
    D --> E{"用户适配器来源"}
    E -->|"config.adapter 声明"| F["动态 import + 契约校验<br/>→ register(user-file)<br/>失败 fail-fast → recordError"]
    E -->|"user-adapters.json 清单"| G["逐条 import + 校验 + register"]
    F --> G
    G --> H{"autoReload === true?"}
    H -->|是| I["每个用户文件建 HotReloadableAdapter<br/>(2s mtime+size 轮询)"]
    H -->|否| J
    I --> J["读 adapter-state.json 恢复启用映射(null=显式清空)<br/>+ 初始化缓存 Map 与 async-mutex"]
    J --> K["注册 7 条路由(loopback 围栏):<br/>stats / history / adapters.json /<br/>select / inspect / add / health"]
    K --> L["预热定时器 setInterval(unref)<br/>(warmupIntervalMs>0 时；启动即取数一次)"]
    L --> M["installSettingsNamespace 只读镜像(apiKey 不回显)<br/>+ ctx.effect 注册卸载清理:<br/>dispose 路由 / 清定时器 / 停热更新 / mutex.cancel"]
```

启动后落盘的两份状态文件（均在历史根目录下）：

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `user-adapters.json` | 设置页 add | 用户适配器清单 `{version:1, adapters:[{id,label,providers,file}]}`，tmp+rename 原子写；POSIX mode 0600（Windows 依赖用户 ACL） |
| `adapter-state.json` | select / add | provider → 启用适配器 name 映射（`null` 表示显式清空）；串行链经独占临时文件（POSIX 0600；Windows 依赖用户 ACL）、文件 fsync、原子 rename（支持目录 fsync 的平台再同步目录）写入。rename 前失败按写入失败处理；rename 后目录 fsync 失败只报「已提交但耐久性未完全确认」。坏 JSON 或非法顶层形态以 no-clobber 方式隔离为 `.bak-<ts>[-n]`，仅留证、不自动恢复，最多轮转保留 5 份；隔离成功后按默认关系继续并允许后续状态重写，只有旧状态读取/隔离失败路径 fail-closed |

关于末步的 `installSettingsNamespace`：它把插件 Config schema 以**只读镜像**形式暴露到设置面板 UI（`setSource`/`onChange` 均为空实现，纯展示；rc.7 的 keyed 渲染约束下不提供运行时写回）——真正的运行时管理由设置页 tab 经 `adapters.json / select / inspect / add` 路由承载，apiKey 不进 schema 故不回显。

---

## 3. 核心时序：`GET /stats` 取数全链路

这是整个插件最热的一条路径。客户端每 60 秒打一次，后台预热每 5 分钟打一次。

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器客户端
    participant R as stats 路由<br/>(loopback 围栏 403/405)
    participant G as getStats()<br/>(缓存 Map + Mutex)
    participant RG as AdapterRegistry
    participant P as runV2Pipeline<br/>(safeFetchData)
    participant AD as adapter.fetchData()
    participant API as 外部用量 API
    participant F as adapter.formatCapsule()

    B->>R: GET /stats?provider=X
    R->>G: getStats(prov)
    G->>G: cacheFresh() 未过 TTL(默认 60s)?
    alt 缓存新鲜
        G-->>B: status=cached（不重新取数）
    else 缓存过期/不存在
        G->>G: mutex.isLocked()?
        alt 锁忙（上次取数还在进行）
            G-->>B: reason=busy, status=stale<br/>（不排队不报红，黄点提示）
        else 锁空闲 → runExclusive()
            G->>RG: getEntry(provider)
            alt 无启用条目
                Note over RG,G: hasCandidates 区分:<br/>无候选=no-adapter / 有候选全禁用=no-enabled-adapter
                RG-->>B: configured=false, status=stale
            else 有启用适配器
                G->>P: runV2Pipeline(adapter, config, timeoutMs)
                Note over P: resolveProviderConfig 密钥链(§7)<br/>组装 FetchContext 入参
                P->>AD: fetchData({apiEndpoint, staticPath, apiKey,<br/>provider, timeoutMs, signal, fetch})
                AD->>API: fetch(apiEndpoint + staticPath)
                API-->>AD: JSON 数据
                AD-->>P: 返回对象（最小数据集）
                Note over P,G: 失败（抛错 / 超 5s 强制超时 / 不可序列化）:<br/>ok=false, reason=fetch-failed, status=stale<br/>（绝不外抛异常；此形态不 format、不落盘）
                P->>F: formatCapsule({time,data,status:fresh,esc})
                F-->>P: HTML 字符串
                Note over P: sanitizeHtml 净化兜底<br/>(script/iframe/on*/javascript:)
                P-->>G: V2PipelineResult(capsuleHtml?, rawData?)
            end
        end
    end
    G->>G: history.append({time,data}) 管线返回后落盘<br/>仅当 ok && fresh && rawData（失败仅记日志）
    G->>G: cache.set(provider, result) 成功与失败结果都缓存
    G-->>B: 200 {capsuleHtml?, status=fresh|stale, adapterName,...}
    Note over B: renderPill(): label.innerHTML = capsuleHtml<br/>状态点 fresh/cached→绿 stale→黄<br/>未配置 → 红点错误态胶囊（provider 名，点击看引导）
```

降级语义速查（客户端状态点颜色由这些字段决定）：

| 场景 | 返回形态 | 客户端表现 |
| --- | --- | --- |
| 正常新取 | `status=fresh` | 绿点，实时数据 |
| 60s 缓存命中 | `status=cached` | 绿点，tooltip 标「缓存」 |
| 锁忙（取数进行中） | `ok=true, reason=busy, status=stale` | 黄点，「取数进行中，稍候自动刷新」 |
| 取数失败/超时 | `ok=false, error=...` | 黄点 + tooltip 错误详情 |
| 无候选适配器 | `configured=false, reason=no-adapter` | 红点错误态胶囊（显示 provider 名）；点开面板见接入引导 + 复制引导指令 |
| 有候选但全禁用 | `configured=false, reason=no-enabled-adapter` | 同上 |

注意：失败与 no-\* 结果同样会写入缓存，TTL 内重复请求直接复用缓存条目（status 改标 `cached`），不会反复打外部 API。

---

## 4. 面板时序：`GET /history` 历史查询

面板内容不走实时取数，而是**从本地历史读**——所以即使外部 API 暂时不可达，已落盘的历史图表依然可用。

```mermaid
sequenceDiagram
    autonumber
    participant B as 浏览器客户端
    participant R as history 路由<br/>(loopback 围栏)
    participant RG as AdapterRegistry
    participant H as HistoryStore
    participant F as adapter.formatPanel()

    B->>R: GET /history?provider=X&days=N
    R->>RG: getEntry(provider)
    alt 无启用适配器
        RG-->>R: undefined
        R-->>B: 200 {ok:false, panelHtml:null,<br/>reason: no-adapter | no-enabled-adapter}
        Note over B: 展示引导文案 + 「复制引导指令」按钮<br/>（指令含 adapter-guide.md 链接，交给 Agent 自主接入）
    else 有启用适配器
        R->>R: 计算 range（days 钳制 ≤ maxAgeDays，缺省 1 天）
        R->>H: query(provider, name, range)
        H->>H: 只扫 range 覆盖的日文件 YYYY-MM-DD.jsonl<br/>过滤 + 按 time 升序稳定排序
        H-->>R: entries 全量返回（不截断）
        R->>F: formatPanel({entries, range, truncated:false, esc})
        F-->>R: HTML 字符串
        Note over R: sanitizeHtml 净化后下发
        R-->>B: 200 {panelHtml}
        Note over B: 面板内容区 innerHTML = panelHtml<br/>优先级：panelHtml > 错误提示 > 加载中
    end
```

---

## 5. 自定义适配器注入：三条路径

### 5.1 总览

```mermaid
flowchart TD
    U(["用户写好 my-stats.mjs<br/>(契约: version=2 + name + providers +<br/>fetchData/formatCapsule/formatPanel)"]) --> PATH

    subgraph PATH ["注入路径"]
        direction LR
        P1["路径 A: cordis.patch.yml 声明<br/>adapter: ~/my-stats.mjs<br/>(启动时加载，兼容态)"]
        P2["路径 B: 设置页添加<br/>(运行时热注册，推荐)"]
        P3["路径 C: autoReload 热更新<br/>(编辑文件自动换版)"]
    end

    P1 --> L1["apply 启动序列中<br/>resolvePath → import → 契约校验<br/>→ register(user-file)"]
    P2 --> L2["inspect 先检测回显<br/>add 确认后注册 + 双文件落盘"]
    P3 --> L3["HotReloadableAdapter<br/>2s mtime+size 轮询"]

    L1 & L2 & L3 --> REG["AdapterRegistry.register → 契约校验 fail-fast：<br/>缺导出/name 非法/version≠2 拒收 + recordError<br/>通过后默认成为该 provider 启用者<br/>(或按 adapter-state.json 恢复的选择)"]
```

设置页主列表的数据源 `GET /adapters.json` 除返回注册表快照（host/enabled/errors）外，还经 `ctx.llm.listProviders()`（插件 `inject` 含 `llm`）带上模型配置页的提供商列表 `modelProviders`，用于把「模型配置中的 provider」与「已注册适配器认领的 provider」对齐展示。

> 注意：运行时注册表**只收 v2 契约（`version === 2`）**；`contracts.ts` 保留的 v1 deprecated 类型仅为编译期引用兼容，不再有加载路径。

### 5.2 时序：设置页「检测 → 添加」（运行时注入的主路径）

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant SP as 设置页 settings.ts<br/>(React tab「用量统计」)
    participant IR as POST /adapters/inspect
    participant AR as POST /adapters/add
    participant V as resolveAddAdapterFile<br/>+ 契约校验
    participant RG as AdapterRegistry
    participant D as 磁盘

    U->>SP: 输入 mjs 文件路径(~ 展开/绝对路径)
    U->>SP: 点「检测文件」
    SP->>IR: {file: "/path/to/my-stats.mjs"}
    IR->>V: 路径安全校验
    Note over V: 拒绝 NUL 字符与未规整形态(a/../b)；<br/>相对路径必须落在 DSH_HOME 或插件 home 内<br/>否则 400 invalid-file
    V->>V: 动态 import + describeUsageStatsAdapterShape
    alt 契约不符
        IR-->>SP: 422 {error, detail:缺失导出明细}
        SP-->>U: 回显排障信息
    else 校验通过
        IR-->>SP: 200 {adapter:{name,label,providers,version}}
        SP-->>U: 回显导出信息（不注册）
        U->>SP: 确认添加
        SP->>AR: {file}
        AR->>V: 同上校验 + import
        AR->>RG: hasName 重名→409 / register(adapter, "user-file", file)
        AR->>D: persistUserAdapter 幂等追加 user-adapters.json<br/>(tmp 写 + rename 原子替换, POSIX mode 0600, 串行链)<br/>+ scheduleWriteAdapterState → adapter-state.json<br/>(独占 tmp〔POSIX 0600〕+ 文件 fsync + rename；rename 前失败进入写失败诊断，rename 后目录 fsync 失败进入独立耐久性诊断)
        AR-->>SP: 200 {ok:true, enabled 映射}
        Note over RG,D: 新登记的适配器默认成为该 provider 启用者；<br/>cache.clear() 使下一轮轮询立即用新适配器取数
        SP-->>U: 列表刷新，胶囊下个轮询周期即出新数据
    end
```

切换/停用走 `POST /adapters/select`（body 为 `{provider, adapterName}` 或 `{provider, adapterName:null}` 显式清空）：`registry.select()` → `cache.clear()` → 启用映射串行落盘，全程无需重启。

### 5.3 时序：autoReload 热更新

```mermaid
sequenceDiagram
    autonumber
    participant T as HotReloadableAdapter<br/>(2s setInterval, unref)
    participant FS as stat(file)
    participant IMP as import(url?t=mtimeMs)
    participant V as isUsageStatsAdapter
    participant RG as AdapterRegistry
    participant C as 结果缓存

    T->>FS: 每 2s 读 mtimeMs + size
    alt stamp 未变
        FS-->>T: 相同 → 本轮结束
    else 文件被删除
        Note over T: 保留当前版本继续服务，不切换
    else stamp 变化
        T->>IMP: import(pathToFileURL(file) + "?t=" + mtimeMs)<br/>(query 参数绕开 ESM 模块缓存)
        IMP->>V: default ?? 具名导出做契约校验
        alt 新版校验失败
            V-->>T: error
            T->>RG: recordError("热更新失败：...", 保留旧版)
        else 校验通过
            T->>RG: removeByFile(file) 先移除旧注册<br/>(改名场景不误报重复)
            T->>RG: register(hr.current, "user-file", file)
            T->>C: cache.clear()
            Note over RG: recordError 登记成功信息<br/>（health/adapters.json 可见）
        end
    end
```

---

## 6. 客户端交互流程

客户端是一个干净模块（`export function apply(ctx)` + `export const inject=[]`），构建期由 `__DSH_ROUTES__` 注入真实路由表。按职责拆两张图：挂载与刷新循环、点击后的面板分支。

### 6.1 挂载与刷新循环

```mermaid
flowchart TD
    S(["客户端 apply(ctx)"]) --> A["ensureStyle 幂等注入样式<br/>ctx.get sessions / connection"]
    A --> B["slots.inject settings.section<br/>注册独立 tab「用量统计」<br/>(独立 try/catch 不连坐浮窗)"]
    A --> C["mountFloat(): 胶囊 button + 面板 div<br/>MutationObserver 自动重挂位<br/>scroll/resize 跟随定位"]
    C --> D["立即 refreshStats() 一次<br/>+ setInterval 60s 轮询<br/>+ visibilitychange 转可见补刷<br/>(每次取数前先 revalidateProvider 复检, #71)"]
    A --> E["provider 检测:<br/>sessions.currentProvideInfo subscribe<br/>(不可用回落 sessions.list subscribe)<br/>→ sessions.models(sessionId)<br/>→ current.provider ?? 回落 opencode-go"]
    E -->|"provider 变化"| F["renderGeneration+1 防竞态<br/>清 lastStats/lastHistory → 重新拉取"]
    E -->|"provider 未变（切换会话）"| G["renderPill 刷标注<br/>+ 立即补刷一次 stats（不等轮询, #71）"]
```

### 6.2 点击胶囊：面板渲染分支

```mermaid
flowchart TD
    P(["用户点击胶囊"]) --> T["toggleFloat(): 展开面板<br/>refreshHistory() 拉 /history"]
    T --> K{"renderPanel 内容优先级"}
    K -->|"panelHtml 有值"| L["innerHTML 注入图表<br/>(stats 失败但历史有图仍展示)"]
    K -->|"no-adapter / no-enabled-adapter<br/>或 历史未拉到且 stats 已示未配置"| M["引导分支: 说明文案 +<br/>「复制引导指令」按钮(指向 adapter-guide.md)"]
    K -->|"其他错误"| N["errorMessage(code) 映射中文提示"]
    K -->|"尚无数据"| O["加载中…"]
```

防竞态与一致性细节：

- **renderGeneration 代 token**：provider 切换/卸载时自增，迟到的旧请求响应直接丢弃；
- **adapterVersion 重置机制（预留）**：客户端在响应 `adapterVersion` 变化时会丢弃旧 `lastHistory`，防止「新数据 × 旧模板」混搭；当前服务端 `/stats` 恒返回 `adapterVersion: 0`，该路径暂不触发（为换版语义预留）；
- **所有异常只 warn**：任何请求失败都不会让 GUI 启动失败或挂起（客户端请求不设硬超时，取数超时由宿主端统一执行——固定 5s）。

---

## 7. 密钥解析链（`resolveProviderConfig`）

`apiKey` 从不要求写在适配器源码里，每次取数前按以下优先级解析（首个命中即返回）：

```mermaid
flowchart TD
    S(["取数前解析 apiKey"]) --> A{"插件配置 apiKey<br/>显式指定?"}
    A -->|是| DONE["使用显式值"]
    A -->|否| B{"环境变量<br/>{PROVIDER}_API_KEY<br/>(大写, 连字符→下划线)"}
    B -->|命中| DONE
    B -->|未命中| C{"provider=opencode-go?<br/>旧变量 OPENCODE_GO_API_KEY"}
    C -->|命中| DONE
    C -->|否| D{"DSH_HOME/.credentials.yaml<br/>先查 {PROVIDER}_API_KEY 字段<br/>(opencode-go 再查旧名 OPENCODE_GO_API_KEY)"}
    D -->|命中| DONE
    D -->|未命中| E{"provider=opencode-go?<br/>~/.local/share/opencode/auth.json<br/>opencode-go 或 opencode 条目(type=api,key=...)"}
    E -->|命中| DONE
    E -->|未命中| NONE["apiKey=undefined<br/>(适配器可自行抛 no-api-key)"]
```

`apiEndpoint` 只有两级：插件显式配置 > 无（由适配器用 `staticPath` 与自身逻辑组合）。密钥仅存在于宿主进程内存，经 `fetchData` 入参注入，不进浏览器端、不进设置面板 schema。

---

## 8. 安全机制一览

| 机制 | 实现 | 位置 |
| --- | --- | --- |
| 路由围栏 | 所有路由 loopback 才放行（非回环 403）、方法白名单（405） | 每个 route handler 入口 |
| 取数超时 | `safeFetchData`: Promise.race + AbortController，强制 timeoutMs（固定 5000ms，不可配置）；结果必须过 JSON 序列化校验 | `core/guards.ts` |
| 渲染超时 | `safeFormat`: 异步 format 超时（与取数同一 timeoutMs 注入，当前固定 5s） + 返回类型校验（同步死循环为文档化风险） | `core/guards.ts` |
| XSS 兜底 | `sanitizeHtml` 白名单式正则净化：script/iframe/frame/object/embed/meta/link/base 标签、on* 事件、`javascript:`/`data:text/html` 协议、CSS `expression(` | `sanitize.ts` |
| 密钥隔离 | apiKey 仅宿主内存，不入设置面板 schema、不下发浏览器 | `provider-config.ts` / `index.ts` |
| 路径安全 | add/inspect 拒绝 `\0`、未规整相对路径；相对路径限 DSH_HOME / 插件 home 内；历史目录名 `safeSegment` 防穿越 | `index.ts` / `contracts.ts` |
| 信息最小披露 | health/errors 中用户文件路径脱敏为 basename 或 `~` 形态 | `index.ts` / `registry.ts` |
| 历史文件 | 按天分片 JSONL，mode 0600；清理在每次 append 后惰性触发——先删过期日文件，再在总大小超限时从最旧删起且恒保留最后 1 个文件防清零；清单文件 tmp+rename 原子写 | `core/history.ts` / `index.ts` |
| fail-fast 加载 | 缺导出 / 类型错 / name 不合白名单 → 拒收并登记可排障错误，不影响插件其余功能 | `contracts.ts` / `registry.ts` |

---

## 9. 关键模块索引

构建链：`src/*.ts` 经 tsc 编译后由 bundle-host 把全部子模块**内联进单一 `lib/index.js`**（发布物自包含、无运行时 npm 依赖），因此契约与核心模块一律在 `src/index.ts` re-export——smoke/lint 只能从 `lib/index.js` 导入。各模块职责：

| 模块 | 职责 |
| --- | --- |
| `src/index.ts` | 宿主端入口：配置归一化、装配顺序、7 条路由、预热定时器、持久化读写 |
| `src/contracts.ts` | v2 契约（UsageStatsAdapter/FetchContext/CapsuleInput/PanelInput）、esc、校验器、v1 deprecated 类型 |
| `src/registry.ts` | 适配器注册表：per-provider 候选列表 + 唯一启用 + 错误登记 + 快照 |
| `src/pipeline/v2.ts` | 取数管道与面板管道：组装入参 → safe 执行 → 净化 → 归一化结果 |
| `src/core/guards.ts` | 用户代码安全执行包装（超时/序列化校验/错误隔离） |
| `src/core/history.ts` | 按天分片 JSONL 存储 + 旧 v3 桶迁移 |
| `src/hotreload.ts` | mtime+size 轮询热更新 + 原子切换 |
| `src/provider-config.ts` | 密钥五级解析链 |
| `src/sanitize.ts` | HTML 结构化净化 |
| `src/adapters/opencode-go.mjs`（+ `.d.mts`） | 内置适配器 opencode-go-builtin：OpenCode Go `/v1/usage` 三窗口用量（#215 mjs 化；另见 deepseek-official.mjs / zai-coding-cn.mjs） |
| `src/client/index.ts` | 客户端入口：胶囊/面板挂载、轮询、provider 检测 |
| `src/client/settings.ts` | 设置页 tab：适配器管理（检测/添加/切换/停用） |
| `src/client/core.ts` | 客户端数据层：fetch 封装、响应类型、会话 provider 解析 |
| `src/client-logic.ts` | 设置页纯函数：provider 列表拆分与徽标文案 |
| `src/path-resolve.ts` | 路径解析：`~` 展开、DSH_HOME 相对路径解析（pluginHome） |
