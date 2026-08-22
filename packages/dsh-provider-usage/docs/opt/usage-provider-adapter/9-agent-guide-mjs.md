# 9. mjs 适配器开发指导（面向 Agent 的引导手册）

> 主文档：[dsh-provider-usage-provider-adapter-plan.md](dsh-provider-usage-provider-adapter-plan.md)
> 契约细节见 [1-contracts.md](1-contracts.md)；配置接线见 [3-config-and-injection.md](3-config-and-injection.md)。
> 本文档目标读者是 **Agent**：当用户说「想接我自己的中转站 / 用量接口 / 只看某个数据源」时，
> 按本文引导用户**写出并登记一个宿主适配器 .mjs**——不是替用户写死业务逻辑，而是给出
> 最小可跑模板 + 契约要点 + 验证方法，让用户把「取数」这一步填进去。

---

## 9.0 什么时候需要写 mjs

先判断，避免过度引导：

| 用户诉求 | 需要 mjs 吗 |
|---|---|
| 用 dsh 已内置的适配器（如 OpenCode Go） | 否，直接用 |
| 接一个「用量型接口」（返回额度/占比/限额，0~100%） | **是**——推荐用工厂模板，几行搞定 |
| 接一个「非用量型来源」（自定义格式、非百分比） | 是——手写完整契约（方式 B） |
| 只想改展示样式/胶囊文案，数据源不变 | 否——那是**客户端渲染器 .js** 的事（见 9.6） |

判断口诀：**取数在宿主（mjs），化妆在客户端（js）**。绝大多数诉求只到 mjs。

## 9.1 一次引导的完整流程

按顺序执行，每步让用户确认后再进下一步：

1. **问清数据源**：接口地址、鉴权方式（试填 token？带在配置里？）、返回什么字段、有没有现成的 curl。
2. **问清 provider 名**：用户在 dsh 模型配置页最终会把这个 provider 选给会话。适配器 `providers` 数组必须精确匹配会话模型名。若 provider 尚未在任何模型配置中，也不影响——可以先用，面板会把它收进「未在模型配置中的适配器」分组。
3. **给模板**：按 9.2（用量型）或 9.3（自定义型）给出可复制的最小文件，让用户填接口地址与字段映射。
4. **让用户落盘**：保存为 `~/.dsh/.../my-relay.mjs`（任意可读路径；面板添加只接受：绝对路径，或相对路径落在 DSH_HOME / 插件 home 内）。
5. **面板登记（推荐路径）**：用量统计设置页 → 展开对应 provider → [+ 添加适配器] → 填文件路径（id/展示名/归属提供商由文件导出自动读取，无需手填）→ 确认。
6. **验证**：展开看「最近一次错误」是否出现；总览区出现该 provider 行即成功。失败按 9.5 排障。

> 备选接线（不点面板）：在 cordis.patch.yml 的 `adapters.host` 里声明
> `- provider: <名> file: <路径>`，重启 dsh web 生效。（面板登记与配置文件二选一即可，混用会因 id 重复被拒。）

## 9.2 用量型适配器最小模板（推荐，工厂）

百分占比、限额、窗口重置这类接口用 `defineUsageAdapter` 最省事——只需要写取数函数和窗口声明，
胶囊文案、历史采样列、状态等级全部自动派生：

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

> 无需 import 任何包：上述模板是**纯对象字面量**，直接 `export default` 即可。
> （插件内部存在 `defineUsageAdapter` 工厂用于自动派生 summarize/samplePoint，
> 但它不是包的公共导出——用户文件不 import，写完整对象即可。）

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
| 总览出现该 provider 但无数据 | 取数失败 | 看行内错误码；可用 curl 先验证接口本身 |
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