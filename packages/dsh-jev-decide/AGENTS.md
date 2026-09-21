# AGENTS.md — dsh-jev-decide 包规则

> 本文件是 `@wingsky-1/dsh-jev-decide` 的**包级规范**（叠加层）。改动本包
> `src/`、`cordis.patch.yml`、`package.json` 前必读。上层规则见仓库根
> `AGENTS.md`（硬性）与 `docs/DEVELOPMENT.md`（权威详细版）。
> 客户端（`src/client/`）由客户端负责人全权处理，宿主端不碰。

## 定位

JEV 决策网关：frozen 预设模板（5 个，templateVersion 恒为 1）+ SystemOne 官方调用
（基址写死）+ 双轨密钥 + 本地密形预检。模型工具 `ws_jev_decide` / `ws_jev_list_presets`，
回环路由 `/api/dsh-jev-decide/*` 五条。配置自持于 `<DSH_HOME>/@wingsky-1/dsh-jev-decide/`
三文件（config.json / presets.json / secrets.json）+ VERSION 存储刻度。

## 目录结构

- `src/index.ts` — 组合根：唯一认识 ctx 的地方；upgrade 最先装配，api 最后。
- `src/server/upgrade/` — 存储锚定：VERSION 缺席按 0，已锚定空转，未来版本 fail-closed 拒绝启动。
- `src/server/config/` — 配置域：`impl/model.ts`（PUT 校验 + 嵌套包络归一 + RETIRED_KEYS）、
  `impl/service.ts`（三文件读写 + 双轨解析，ENV 优先）。
- `src/server/store/` — 落盘原语：目录 0700 / 文件 0600 / 临时文件+随机后缀+rename。
- `src/server/history/` — 分文件 jsonl：每会话 200 轮转，总会话 50（只保数量语义）；
  snippet 先脱敏后截断 ≤200 字，密钥永不入库。
- `src/server/tools/` — 校验（中文仅 ID 限 ASCII，正文中文合法）/ 预检（命中不离境直转人工）/
  客户端（总预算超时 + 有限重试 + 信号量，fetch 注入）/ 输出（DecideOutput 为准，截断强制 suggest-only）。
- `src/server/api/` — loopback 围栏（403 先于 405，体统一 errorCode+category）与五端点。
- `src/shared/contract.ts` — 两端共享契约唯一事实源；谁也不许单方面改，缺口上报主代理。

## 改动前必守（本包特有红线）

1. **改 `src/` 必须 build 才生效**：dsh 经 profile 直读 `lib/` 产物，不自动编译。
2. **双轨密钥**：ENV 引用优先，明文写入须二次确认且服务端同样校验互斥；
   密钥形状拒收 400 仅回类别；GET/PUT 成功响应一律掩码，密钥原文永不回显、不入库、不进日志。
3. **frozen 预设**：5 预设模板 frozen 在 `FROZEN_PRESETS`，templateVersion 恒为 1；
   `secret-leak` 默认关闭；custom 须自带全量题目，非 custom 的 override 须等长同 id 集。
4. **官方地址写死**：`JEV_BASE_URL` 为加载断言常量，不接受任何配置覆盖；
   PUT 遇 `baseUrl` 类退役键直接 400。新增上游一律先报主代理裁决，不私自加基址。
5. **loopback 围栏**：全部路由非回环 403 先于方法 405；smoke 必须含 403/405 围栏用例。
6. **安全语义变更同步包 README 的「安全模型」节与测试**（仓库硬性要求）。

## 文档指针

- 用户面：包 `README.md`（中文）/`README.en.md`（英文），节标题 1:1 对齐；
  「后续项」节记 deferred 事项（启动自检迁移、三文件组写崩溃窗口容忍）。
- 架构总览：`docs/architecture/` 内本包架构文（落盘后补链）。

## 验证（提交前自查，不 commit）

> 完成定义以根 `AGENTS.md` 门禁矩阵为**单一事实源**；下列命令只作提交前自查。

```sh
pnpm --filter @wingsky-1/dsh-jev-decide typecheck
pnpm --filter @wingsky-1/dsh-jev-decide build
pnpm --filter @wingsky-1/dsh-jev-decide test
```

测试全离线 mock（fetch 注入），落盘测试走 `mkdtempSync`；集成禁止写真实环境（env 经组合根注入）。

## 提交

Conventional Commits，中文 subject，禁 emoji；不 commit（由主代理整合提交）。
