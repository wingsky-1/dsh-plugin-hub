# [ADR 草稿·未发布] 决策：向 DSH 上游提议 webServer 官方路由装饰/中间件 API（#35）

> 红线批次文稿：对外动作（以维护者身份向上游仓库提交 feature request），
> 须维护者确认后由其本人或明确授权代发。本文稿仅为上游 issue 文稿草案。

## 提议标题（拟）

feat(webServer): official route-decoration / middleware API for cross-cutting plugin concerns

## 文稿正文（拟）

### 背景

插件生态当前通过 patch `webServer` 非官方实例字段（`prefixes` / `exact` / `fallback` / `register` / `registerFallback`）实现 HTTP 响应压缩等横切能力。实证评审发现该挂载面存在整类缺陷：包装/卸载不对称、幂等标记跨包失效、HMR 重载残留、第三方替换被覆盖、闭包陈旧。

### 提议 API

```ts
ctx.webServer.use((req, res, next) => { ... })      // connect 风格中间件席
ctx.webServer.decorate("prefix", "/api", wrapper)   // 已注册路由的官方装饰入口
```

### 要求

- 官方承诺结构稳定 + 卸载语义（disposer 对称）+ 多插件叠加顺序契约。

### 收益

- gzip 类压缩插件不再需要 symbol 幂等标记 / patched 数组逆序恢复等防御性代码；
- 消除「上游改内部结构 → 静默退化」的隐式契约风险；
- 第三方插件获得稳定横切扩展点。

## 本仓后续（若上游接受或给出替代方案）

评估 dsh-lan-proxy 转发层 compression 方案与 gzip 遗留实现是否迁移（验收标准见 #35）。

## 关联

本决策 issue 获批后：以维护者身份向上游提交上述文稿 → 上游 issue 被接受或给替代方案时关闭 #35。
