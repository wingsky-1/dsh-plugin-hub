# 3. 配置 Schema 与用户 JS 注入（子文件）

> 主文件：[dsh-opencode-usage-provider-adapter-plan.md](dsh-opencode-usage-provider-adapter-plan.md)（阶段总览）
> 本文件细化 M2 的配置入口：完整 schema、路径解析、用户宿主/客户端 js 的注入通道、
> 加载校验与降级矩阵。

---

## 3.1 完整配置 Schema

沿用现有 `normalizeConfig` 净化风格（未知键丢弃、非法值回退默认、防默认污染）。

```yml
plugins:
  ui-dsh-opencode-usage:
    # —— 既有键（不变） ——
    enabled: true
    baseUrl: https://opencode.ai/zen/go/v1/usage   # 默认官方；token 转发目标
    timeoutMs: 15000
    cacheTtlMs: 30000
    limits: { rolling: 12, weekly: 30, monthly: 60 }
    apiKey: ""
    maxAgeDays: 30
    sampleIntervalMs: 300000
    persistFile: ""
    # —— 新增：适配器（D2：本地文件路径；D6：候选 + 可独立启停） ——
    adapters:
      host:                 # 宿主端取数适配器（中转站对接，可多个候选）
        - provider: my-relay
          file: /path/to/my-relay-host.mjs
          enabled: false    # 可选：显式关闭，缺省 true（见 3.1b 默认启用策略）
        - provider: opencode-go
          file: /path/to/custom-opencode-go-host.mjs  # 与内置同 provider，作为候选（非覆盖）
      client:               # 客户端渲染器（卡片）
        - file: /path/to/my-relay-client.js
    # —— 新增：provider 白名单兜底（仅当 M0 探针① 失败时使用） ——
    providerHint:
      my-relay: /path/to/my-relay-host.mjs   # 显式绑定 name→适配器文件
```

`CONFIG_KEYS` 新增：`adapters`、`providerHint`（`provider` 属现有 baseUrl 语义，不重复）。

### 3.1b 默认启用策略（D6）

- 同 provider 允许多个候选（内置 + 用户若干），**任一时刻一启用**。
- 默认启用：内置 opencode-go 适配器；配置中显式列出的用户宿主适配器（`enabled` 缺省 true）。
- `enabled: false` 显式关闭该候选。
- 运行时切换启用走 `POST /adapters/select`（见 `7-dataflow-and-errors.md` §7.1 切换时序），
  M3b 设置面板持久化选择。
- **修正 D4 语义**：用户适配器不再是「直接覆盖内置」，而是加入候选并以「启用」为准。
  旧配置（仅列用户适配器、无 enabled）→ 默认启用，行为无感升级。

---

## 3.2 路径解析规则

`resolvePath(p)`：
1. `~`/`~user` 前缀 → 当前用户 home 展开。
2. 绝对路径 → 原样。
3. 相对路径 → 依次尝试相对 `process.env.DSH_HOME`（默认 `~/.dsh`）与相对插件
   `home` 目录（`~/.dsh/plugins/<plugin>` 归属区），先命中者胜。
4. 解析后做 `existsSync` / 可读校验；失败 → 记诊断 + 该条目跳过（见 3.5 降级）。

---

## 3.3 宿主端用户 js 注入（M2-A）

```ts
const url = pathToFileURL(resolvePath(cfg.file)).href; // ESM
const mod = await import(url);                         // Node ≥20 内建
const adapter = mod.default ?? mod;                     // 默认导出优先
validateAdapter(adapter);                               // 见 1-contracts §1.1
registry.register(adapter);
```

- 支持 `.mjs`（ESM）/ `.cjs`（`createRequire`）/ `.js`（按 package type 判定）。
- 多个文件依序加载；单个失败**不阻断**其余（continue）。
- 加载异常（文件缺失 / 语法错 / 抛错）→ `console.warn` + 该 provider 回落 `no-adapter`。

---

## 3.4 客户端用户 js 注入（M2-B，D4：插件主动拉取 + 契约版本化）

**不再依赖「tapIndex 注入顺序 + 全局读」的脆弱方式**，改为插件主动加载：

1. 宿主端把每个用户客户端 js 文件作为静态资源 serve：
   `GET /api/dsh-opencode-usage/user/<n>.js`（loopback 围栏 + 方法校验）。
2. 宿主端通过一个**元数据路由**告诉客户端有哪些用户渲染器文件：
   `GET /api/dsh-opencode-usage/adapters.json`
   → `{ client: [{ file: "/api/.../user/0.js", version: 1 }], host: [...] }`。
3. 插件客户端 apply 后：
   - `fetch(adapters.json)`；
   - 对每个 client 条目动态加载并执行其模块体（渲染器自注册）；
   - （通道 B 备选：把 js 文本拉回后 `import(URL.createObjectURL(blob))` 加载，
     避免污染全局；实现更繁琐，默认走 serve + 自注册）。
4. 自注册承载：渲染器经版本化桥接注册，例如
   `window.__DSH_USAGE__?.registerRenderer({ version, providers, render })`；
   插件客户端校验 `version`，不匹配则 warn 跳过。
5. 加载失败（404 / 语法错 / 版本不符）→ warn + 该 provider 回落「未配置」，不阻断
   插件其余部分。

**为何不单用 tapIndex**：注入 `<script>` 的加载执行顺序与客户端 bundle 不可控，且
全局命名空间是隐式契约。主动 fetch + 版本化把「何时、以何契约加载」显式化、可等待、
可重试。

（保留 tapIndex 仅作为「注入 `<link>`/polyfill 等素材」的补充通道，不承担渲染器
加载。）

---

## 3.5 加载降级矩阵

| 失效场景 | 宿主适配器 | 客户端渲染器 | 插件其余功能 |
| --- | --- | --- | --- |
| 文件不存在 / 路径错误 | 该 provider 回落 `no-adapter`，warn | 同左，回落「未配置」 | 继续 |
| 语法错误 / import 抛错 | 回落 + 诊断 | 回落 + 诊断 | 继续 |
| 契约版本不符 | 不注册 + warn | 不注册 + warn | 继续 |
| 运行时 `fetchUsage` 抛错 | 归一化 `adapter-crash` | — | 继续 |
| 运行渲染抛错 | — | 保留上次成功数据 + 显示错误 | 继续 |
| 全部用户 js 失败 | 只剩内置适配器 | 只剩内置渲染器 | 照常 |

---

## 3.6 示例中转站模板（M2 交付物）

`docs/opt/usage-provider-adapter/examples/my-relay/`：
- `my-relay-host.mjs`：实现 `HostProviderAdapter`（拉你中转站的用量接口 → 归一化）。
- `my-relay-client.js`：实现 `ClientProviderRenderer`（渲染卡片）。
- `README.md`：手把手接线 + 配置 yml + 冒烟步骤。
目的：验证「识别 provider → 拉数 → 渲染卡片」端到端链路，也作社区投稿模板。
