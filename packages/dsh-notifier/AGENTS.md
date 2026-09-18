# AGENTS.md — dsh-notifier 包规则

> 本文件是 `@wingsky-1/dsh-notifier` 的**包级规范**（叠加层）。改动本包
> `src/`、`test/`、`cordis.patch.yml`、`package.json` 前必读。上层规则见仓库根
> `AGENTS.md`（硬性）与 `docs/DEVELOPMENT.md`（权威详细版）。

## 定位

审批 / 提问 / 完成 / 出错事件通知：宿主事件经裁决管线投递到浏览器通知、系统 toast、
Bark / webhook 出站实例三类出口。配置自持于 `<DSH_HOME>/@wingsky-1/dsh-notifier/`，
设置卡片与宿主端读同一份设置形状（见 `src/server/config/impl/model/type.ts`）。

## 目录结构

- `src/index.ts` — 组合根：本地 `FrameBus`（裁决管线 → 浏览器出口的帧旁路）与各域装配。
- `src/server/config/` — 配置域：`impl/model/`（形状与 `DEFAULT_CONFIG` 默认表）、
  `impl/input/`（归一化、`RETIRED_KEYS` 退役键 400 话术）、`impl/redact/`（凭据掩码）。
- `src/server/upgrade/` — 升级链：0.2.3 顶层渠道键搬进 `channels` 内置条目后删除。
- `src/server/channels/` — 渠道出口（system / browser / bark / webhook）与投递管线。
- `src/server/api/` — loopback 路由（含 `/events` SSE 与 `/config` 掩码视图）。
- `src/shared/` — 两端共享叶子（`sounds.ts` 音色白名单、`webhooks.ts` 认证与预设）。
- `src/client/notify/` — 客户端通知面：`audio.ts`（节流 `PLAY_THROTTLE_MS`、手势解锁）、
  `session.ts`（EventSource 订阅、`since` 补拉与 seq 去重）。
- `docs/sound-playback-design.md` — 系统提示音语义与回退链的决策沉淀。

## 改动前必守（本包特有）

1. **改 `src/` 必须 build 才生效**：dsh 经 profile 直读 `lib/` 产物，不自动编译。
2. **loopback 围栏**：全部路由仅接受回环调用（非回环 403）；smoke 必须含 403 / 405
   围栏用例。经 `dsh-lan-proxy` 转发的请求按设计视为受信，语义只引用该包 README。
3. **凭据红线**：凭据只走请求头与已知 secret 字段（`CHANNEL_SECRET_FIELDS` 单一事实源），
   不拼 URL；`GET /config` 与 PUT 成功响应一律掩码；新实例提交掩码 400；错误 `detail`
   按原文截断、不做凭据替换（见包 README「安全模型」）。
4. **D-Bus 残余信任面**：Linux 通知正文交给 `org.freedesktop.Notifications` 当前 owner
   （同 UID 可抢占）；能力探测只发 `NameHasOwner` 与 `ListActivatableNames` 两个只读查询，
   不触发服务激活。改动探测或通知投递前重读包 README「安全模型」对应条目。
5. **安全语义变更同步包 README 的「安全模型」节与测试**（仓库硬性要求）。

## 文档指针

- 用户面：包 `README.md`（中文）/ `README.en.md`（英文），节标题 1:1 对齐。
- 发声决策：`docs/sound-playback-design.md`；架构总览：`docs/architecture/dsh-notifier.md`。
- 评审样本 `docs/dsh-notifier-uiux-v022-sample.html` 为 v0.2.2 归档 mock，不代表现行设置卡。

## 验证（提交前全跑）

> 完成定义以根 `AGENTS.md` 门禁矩阵为**单一事实源**；下列命令只作提交前自查。

```sh
pnpm --filter @wingsky-1/dsh-notifier build
pnpm --filter @wingsky-1/dsh-notifier test
```

## 提交

Conventional Commits（如 `docs(dsh-notifier): ...`），中文 subject，禁 emoji；
不 commit（由主代理整合提交）。
