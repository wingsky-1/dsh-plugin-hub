# AGENTS.md — 包级规则（packages/）

本层规则补充根 [AGENTS.md](../AGENTS.md) 的全局约定，适用于 `packages/` 下所有
插件包。新建或修改包前先读本文件与根 AGENTS.md。

## 包形态

- **独立 cordis bundle 包**：`"type": "module"`，`"dsh": { "bundle": { "patch":
  "./cordis.patch.yml" } }` 声明 bundle 激活；有浏览器半区的包加 `dsh.client`
  声明（`platform: "web"`）。
- **host / client / core 分层**：`src/index.ts` 是 host 半区（运行在 dsh host
  进程）；`src/client.ts`（或 `src/client/` 目录）是 browser 半区（Web GUI）；
  `src/core/` 是两侧共享的纯逻辑。新增源码文件尽量落在这三区之一。
- **exports 条件导出**：`.` 提供 host（`{ types, default }`）；有 client 的包补
  `./client`；`./package.json` 保留。类型来自 tsc 产物 `lib/*.d.ts`。
- **patch id**：独立包 `ui-<目录名>`（如 `ui-dsh-notifier`）；不带 config（schema
  默认值兜底）。改 patch 后必须 `node ../../scripts/aggregate.ts` 重新生成聚合 patch。

## 构建与契约

- **只改 `src/`，禁止手改 `lib/`**（build 会 clean-lib 清空重建）。
- **构建链**：`node ../../scripts/clean-lib.ts && tsc -p tsconfig.json && node
  ../../scripts/bundle-host.ts .`——host 端 tsc + esbuild 内联 shared + d.ts X1；
  客户端走 `scripts/build-client.ts`（契约外壳生成，禁止包内复制 esbuild 参数）。
- **客户端契约**：load id === 完整包名（浏览器 arrive 校验）；IIFE 闭包工厂 +
  factory + `exports.apply`/`exports.inject`；`Symbol.toStringTag=Module`；load 在
  文件末尾恰好一次；自包含零依赖；挂载失败只 `console.warn`。
- **共享层引用**：`import ... from "../../../shared/..."`（packages/ 布局三级）；
  shared 是 js+d.ts 双写，host 端 strict 编译。
- **零运行时依赖**：发布物自包含；不引入第三方 npm 运行时依赖。

## 路由与安全

- **全部路由强制 loopback 围栏**（共享 `../../../shared/loopback.js` 的
  `isLoopbackRequest`）：非回环 403、方法不匹配 405；smoke 必须带 403/405 用例。
- **health 路由必项**：`/api/<短名>/health`（GET + loopback），返回
  `{ ok: true, plugin, ...状态摘要 }`——诊断「插件没生效」的标准入口。
- 主机端 `ctx.effect` 的 fn 立即执行，清理必须写在返回的 disposer 里；手动
  disposer（`webServer.register`/`tools.register`/`ctx.on`/watcher）收集后统一
  卸载。
- 涉及密钥/凭据/远程执行/令牌的包，修改安全语义时同步更新 README 与测试；安全
  模型放包 README 的 `## 安全模型` 一节。

## 测试

- 每包 `test/smoke.ts`，复用 `../../../test/smoke-lib.ts` 的契约断言
  （`assertClientSourceContract`/`assertClientProductContract`）；业务断言保留在
  各自文件。
- 新功能/修复必须带 smoke 断言；客户端包必须有 load id === 包名契约断言。
- smoke 全部无网络、无真实凭据、本地可直接运行。

## 文档

- 新包自带 README（`README.md` + `README.zh.md`，中英配对，均可公开）。
- README 随行为更新：改动触及 README 描述的行为时同步更新。