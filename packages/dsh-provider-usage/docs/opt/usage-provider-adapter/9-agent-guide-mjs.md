# 9. mjs 适配器开发指导（面向 Agent 的自主引导手册）

> 主文档：[dsh-provider-usage-provider-adapter-plan.md](dsh-provider-usage-provider-adapter-plan.md)
> 契约细节见 [1-contracts.md](1-contracts.md)；配置接线见 [3-config-and-injection.md](3-config-and-injection.md)。
> 本文档目标读者是 **Agent**：当用户说「想接我自己的中转站 / 用量接口 / 只看某个数据源」
> 时，**默认自主执行**——自行调研、命名、设计模板，只在关键决策点把方案交还用户审核。
> 用户也可从设置页复制「一句话引导指令」发起（见 9.1）。

---

## 9.0 自主引导原则（先读）

1. **能自己做的绝不问**：接口地址、鉴权方式、字段含义、命名、保存路径……凡能从
   用户既有信息（模型配置、会话上下文、公开官方文档）推断或查证的，一律自行完成。
   **API 端点优先从模型配置的 baseUrl 读取**（该 provider 的请求入口），用量接口按
   同域惯例（`/v1/usage`、`/usage`、`/quota` 等）或官方文档确认——不为此问用户；
   拿不到 baseUrl 且官方文档也没有用量接口说明时，才在审核卡里如实标「端点未知，
   需要用户提供」。
2. **决策必须交还审核**：自主做的一切实质决策（数据源选择、id/展示名/窗口字段、
   接口地址、保存路径、是否登记），在动手生成/登记前，用**决策审核卡**（9.1 步骤 3）
   一次性呈现给用户确认。用户确认后继续，用户改了就按改的来。
3. **只有确认无解才问**：穷尽所有可查手段（官方文档、配置、历史上下文）仍无法确定
   接口/鉴权时，才向用户提出**最小必要**问题（问数据源地址或鉴权方式，不重复问
   命名等可由 agent 决策的事）。

判断口诀：**取数在宿主（mjs），化妆在客户端（js）**。绝大多数诉求只到 mjs。

## 9.1 一句话指令 + 完整引导流程

**设置页入口**：在某提供商无候选（或列表为空）时，界面提供「复制引导指令」按钮——
用户把复制的一句话发到会话，即触发本流程。指令示例（设置页/浮窗实际复制的文案与此
一致，且末尾带本文档引用，Agent 收到后应首先查阅）：

> 请为提供商 \<provider\> 创建用量统计适配器：以该提供商在模型配置中的 API 端点
> （baseUrl）为起点，自行确认用量接口与鉴权方式，自主设计适配器方案（id/展示名/窗口字段），
> 先给我审核方案（含 API 端点），确认后生成 .mjs 文件、告诉保存路径并引导我在
> 「用量统计」设置页添加适配器。按 mjs 适配器开发指导文档
> （packages/dsh-provider-usage/docs/opt/usage-provider-adapter/9-agent-guide-mjs.md）
> 执行引导流程。

收到后按以下流程执行（默认全程自主，只保留审核点）：

1. **盘点已知**（0 提问）：从用户当前会话/模型配置/已有文件的上下文收集：provider 名、
   baseUrl、apiKey、已有的接口线索。
2. **自主调研**（0 提问）：先取该 provider 在模型配置中的 **baseUrl**（API 端点），
   基于它确认用量端点（同域惯例路径 + 官方文档交叉验证）、鉴权头、返回结构。查到即用；
   能从已有信息合理推导（如 `{baseUrl}/v1/usage`、Bearer 鉴权）也直接用并标注「推断」。
   端点确认结果必须写进决策审核卡「接口」行（**必填**，交用户审）。
3. **产出决策审核卡**（给用户看，等确认）：用简短清单列出全部实质决策，例如：

   ```text
   ── 适配器方案（请审核）────────────────
   · provider 认领：my-relay（来自你的模型配置）
   · API 端点（baseUrl）：https://relay.example.com/v1（来自模型配置）
   · 用量接口：GET https://relay.example.com/v1/usage（同域惯例 + 官方文档 → 链接）
   · 鉴权：Authorization: Bearer <ctx.apiKey>（走插件解析链）
   · 窗口：5h 滚动(percent) / 每周(percent) / 请求数(计数)
   · id：my-relay（kebab-case，与数据源同名）
   · label：我的中转站（中文展示名）
   · 保存路径：~/.dsh/plugins/provider-usage/my-relay.mjs
   · 登记方式：设置页 [+ 添加适配器]（仅填文件路径，热注册）
   ───────────────────────────────────────
   确认 or 调整哪一项？
   ```

   只有这一步需要用户回应。用户确认后**不再逐项追问**，一次做到位。
4. **生成 .mjs**：按 9.2 / 9.3 模板落盘到确认的路径。
5. **引导登记**：告诉用户到设置页对应提供商「+ 添加适配器」→ 填该文件路径 →
   「检测文件」回显与方案一致 → 确认添加（热注册，无需重启）。或由用户在
   cordis.patch.yml `adapters.host` 声明（二选一）。
6. **引导验证**：按 9.6 排障速查确认面板总览/徽标出现预期数据；失败时先按
   「最近一次错误」自查修复，仍不行再简化提问。

## 9.2 用量型适配器最小模板（推荐）

百分占比、限额、窗口重置这类接口用**纯对象字面量**（无需 import 任何包）——
只需要写取数函数和窗口声明，胶囊文案、历史采样列、状态等级由插件自动派生：

```js
// my-relay.mjs —— 用量型适配器模板
export default {
  version: 1,
  id: "my-relay",            // 唯一名：注册表去重、面板候选展示、历史目录名
  label: "我的中转站",        // 展示名
  providers: ["my-relay"],   // 认领的 provider 名（与会话模型名精确匹配）

  // 窗口声明：值对象不含 percent（percent 来自 fetchUsage 结果）
  windows: [
    { key: "5h",  name: "5h 滚动", limit: 100 },
    { key: "week", name: "每周",   limit: 1000 },
  ],

  async fetchUsage(ctx) {
    // ctx: { provider, apiKey?, baseUrl?, timeoutMs, fetch, signal? }
    const res = await ctx.fetch(`${ctx.baseUrl ?? "https://relay.example.com/v1/usage"}`, {
      headers: { ...(ctx.apiKey ? { Authorization: `Bearer ${ctx.apiKey}` } : {}), Accept: "application/json" },
      signal: ctx.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return { ok: false, provider: ctx.provider, label: this.label, fetchedAt: Date.now(), error: "unauthorized" };
    }
    if (!res.ok) {
      return { ok: false, provider: ctx.provider, label: this.label, fetchedAt: Date.now(), error: `http-${res.status}` };
    }
    const body = await res.json();
    return {
      ok: true,
      provider: ctx.provider,
      label: this.label,
      fetchedAt: Date.now(),
      windows: [
        { key: "5h",  name: "5h 滚动", percent: body.hourlyPercent ?? null, raw: body.hourlyRaw, resetsAt: body.hourlyResetAt },
        { key: "week", name: "每周",   percent: body.weeklyPercent ?? null, raw: body.weeklyRaw },
      ],
      data: body, // 原始结构透传（编排层不解读，渲染器可选展示）
    };
  },
};
```

契约要点（不满足则被拒收，面板会显示具体缺什么）：

- `version` 必须 === `1`（ADAPTER_CONTRACT_VERSION）；
- `id` / `label` / `providers`（非空字符串 / 非空数组，`providers` 每项与 provider 名精确匹配）；
- `fetchUsage(ctx)` 返回 `ProviderUsage`：强制最小集 `{ ok, provider, label, fetchedAt }`；
- 失败不要抛错吞掉，返回 `{ ok: false, provider, label, fetchedAt, error: <码> }`；
  错误码见契约：`unauthorized` / `timeout` / `network` / `bad-json` / `http-<status>` 等。

## 9.3 完全自定义适配器（方式 B）

不使用 windows 约定、完全自定义数据/文案/采样列时，手写完整契约对象，把
`summarize`（胶囊文案，**只准从 ctx.usage 派生，禁止独立网络请求**）与
`samplePoint`（历史采样列）一并补上：

```js
export default {
  version: 1,
  id: "my-custom",
  label: "自定义来源",
  providers: ["my-provider"],
  async fetchUsage(ctx) { /* ... 返回 { ok, provider, label, fetchedAt, data: <自由结构> } */ },
  async summarize(ctx) {
    const pct = ctx.usage?.data?.percent; // 仅派生，无网络
    return { ok: true, provider: ctx.provider, label: this.label,
             text: typeof pct === "number" ? `用量 ${pct}%` : this.label,
             level: typeof pct === "number" && pct >= 90 ? "warn" : "ok",
             hasAdapter: true, fetchedAt: Date.now() };
  },
  samplePoint(usage) {
    const pct = usage.data?.percent;
    if (typeof pct !== "number") return null;
    return { cols: [{ key: "percent", name: "用量" }], values: [pct] };
  },
};
```

> 插件内部存在 `defineUsageAdapter` 工厂（自动派生 summarize/samplePoint），但**不是
> 包的公共导出**——用户文件不 import，写完整对象即可。

## 9.4 安全约定（必须对用户讲清，不能省）

- 该 .mjs **在宿主 Node 进程内以完整权限执行**——只登记你信任的本地文件；
- `ctx.apiKey` 仅作取数入参，**禁止**把它写进返回体 / 日志 / 透传给第三方；
- 面板添加只接受规整路径（禁 `..` 穿越），错误消息自动脱敏路径，不要自行打印绝对路径。

## 9.5 验证与排障速查

| 现象 | 原因 | 动作 |
|---|---|---|
| 折叠徽标「未启用适配器」 | provider 无启用候选 | 展开 → 开启某适配器开关 |
| 行内「最近一次错误：契约校验失败（缺 fetchUsage）…」 | 导出形状不满足 9.2 要点 | 按缺项清单补齐 |
| 行内「最近一次错误：加载错误 …Cannot find module…」 | 文件路径错 / 语法错 | 检查路径与 `export default` 写法 |
| 添加返回「文件不存在/不可读，或路径未规整」 | 相对路径越界或含 `..` | 用绝对路径，或放 DSH_HOME 内 |
| 添加返回「适配器 id 已存在」 | 同 id 已注册（含重启合并的清单） | 换 id；或这是更新场景，见 9.7 |
| 面板出现该 provider 但无数据 | 取数失败 | 看行内错误码；可用 curl 先验证接口本身 |
| 数据一直不刷新 | 命中缓存窗口 | 等 cacheTtlMs（默认配置）或切换一下适配器触发重取 |

## 9.6 顺带区分：客户端渲染器不是这里管的

用户若想改**展示形态**（卡片/胶囊样式），那要写客户端 `.js` 并经
`window.__DSH_USAGE__.registerRenderer()` 自注册，通过 cordis.patch.yml 的
`adapters.client`（file/url）配置注入——**面板的添加适配器只管宿主取数侧**。
默认情况下只要 mjs 返回标准 `windows`，内置通用渲染器已足够展示，无需客户端文件。

## 9.7 Agent 引导注意事项（热更新边界）

- 面板「添加适配器」= **热注册**：登记后立即生效，无需重启 dsh（smoke 有硬断言）；
- **更新已登记适配器不是热的**：ESM `import()` 同一路径有模块缓存、且同 id 重复登记被拒。
  更新逻辑 = 改文件 → **换一个 id** 重新登记，或修改后**重启 dsh web**（重启合并加载清单时按新文件内容注册）；
- 面板当前**没有删除/移除**已登记适配器的入口，改主意需在配置层或清掉 `user-adapters.json`（谨慎，重启后生效）。