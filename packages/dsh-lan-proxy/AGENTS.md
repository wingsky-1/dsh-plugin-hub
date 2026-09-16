# AGENTS.md — dsh-lan-proxy 包规则

> 本文件是 `@wingsky-1/dsh-lan-proxy` 的**包级规范**（叠加层）。改动本包
> `src/`、`test/`、`cordis.patch.yml`、`package.json` 前必读。上层规则见仓库根
> `AGENTS.md`（硬性）与 `docs/DEVELOPMENT.md`（权威详细版）。

## 定位

局域网访问 dsh web UI 的转发器：在 `0.0.0.0:<port>`（默认 HTTP 3081、
HTTPS 3443）监听，把 HTTP/HTTPS 与 WebSocket/wss 转发到回环 web 服务器
（默认 `127.0.0.1:3080`），重写 Host/Origin 以通过 /api 浏览器信任围栏。
端口/证书/压缩路径等均可经 GUI 设置卡片热更新（配置存官方 settings 存储，
issue #110 起不再使用自建 config.json）。

## 目录结构

- `src/index.ts` — 插件契约与包导出面（`name`/`inject` + 逐域 re-export）。
  **必须留在 `src/` 根**：`tsconfig` 的 `rootDir=src` 决定产物入口是 `lib/index.js`，
  `bundle-host` 以它为唯一 esbuild 入口，搬进子目录会因找不到入口而构建失败
- `src/server/apply.ts` — 装配层：按依赖顺序串起配置域、迁移域与转发引擎域并注册
  生命周期；所有清理统一写在 `ctx.effect` 返回的 disposer 里
- `src/server/shared/` — 包内共享叶子（`DEFAULT_OPTIONS` / `DEFAULT_DEFLATE_POLICY` 与
  `DeflatePolicy` / `isLoopbackTarget`）。无单一归属的常量与协议级谓词只该落这里——
  留在任一域都会让另一域反向依赖（#826 域归位时这三个符号就是从 `proxy.ts` 整块上移的：
  配置域 schema 与引擎域都要用它们，留在引擎域会让配置域反向依赖）
- `src/server/proxy/` — 转发引擎域：`impl/proxy.ts` 承载 `createLanProxy`
  （HTTP/HTTPS/WebSocket 桥接、Host 重写、DNS 重绑定防护、wss 压缩桥接）与全部
  纯判定函数；`interface.ts` 收口对外承诺。
  HTTP 响应压缩（原独立包 dsh-gzip 已退役并入；compression@1.8+ 按 Accept-Encoding 协商；档位预设经 resolveCompressionOptions 映射，gzip 与 Brotli 两侧参数同时下发）也在此层：经成熟开源库
  `compression` 中间件挂在转发器自己的 `createServer` 处理链上（构建期 esbuild
  内联进产物），自定义 filter 复用 `isCompressible`（SSE 豁免）；
  协商 / Vary / Content-Length 删除 / Range·204·304 豁免全部由库承担。
  上游已带 content-encoding 时本层自动让位（由库的 already encoded 分支判定；
  与宿主端任意压缩实现共存只压一次，smoke 有专项用例锁定）。
  **Brotli 生效条件不得写成「br 优先」**：dsh 自身 webServer 自带 gzip 且只协商 gzip，
  实测（见 [`docs/official-lan-access-overlap-assessment.md`](./docs/official-lan-access-overlap-assessment.md) §4.1）只有客户端仅声明 br
  且上游未压缩时本层才产出 br；主流浏览器同时声明 br 与 gzip，实际拿到上游 gzip。
  该情形仍远优于不压缩（322900 → 5065 字节），且两层不会重复压缩。
  **禁止**在 webServer 宿主端 patch handler 实现压缩（非官方 API 挂载面，
  曾引出包装/卸载/幂等一整类缺陷）；**禁止**手写响应流 gzip 接线（一律走
  compression 中间件）
- `src/server/tls/` — TLS 域（配置证书加载 / 自签名生成并缓存到
  `<DSH_HOME>/lan-proxy/`，私钥落盘 0600）
- `src/server/config/` — 配置域：`impl/model.ts`（schema / 校验 / 存量归一化）、
  `impl/routes.ts`（loopback HTTP 配置面）、`impl/namespace.ts`（官方 settings 接线）
- `src/server/migrate/` — 存量 `config.json` 一次性迁移域，历史格式知识只在本域出现
- `src/client/` — 客户端（干净模块：`index.ts` + `style.css` + `css.d.ts`，另有
  `locales.ts` 与 `settings-card.tsx`）；端内共享叶子在 `src/client/shared/`
  （`defaults.ts` 是展示缺省值的单一事实源 + `interface.ts` 门面）——与 `src/server/shared/` 同形
- `test/{unit,integration,e2e,client}/` — 单元 / 集成（真实 cordis 生命周期 + 真实转发器，
  进变异面）/ 冒烟（真端口 + 子进程，不进变异面）/ 客户端产物用例，由 `pnpm test` 统一调度
- `cordis.patch.yml` — patch（id `ui-lan-proxy`）

## 改动前必守（本包特有）

1. **改 `src/` 必须 build 才生效**：dsh 经 profile 直读 `lib/` 产物，不自动编译。
   `lib/` 是构建产物，禁止手改（build 会清空重建）。
2. **转发安全红线**（运行时与配置层双重校验，改动时不得放宽）：
   - `targetHost` 仅允许回环地址（localhost / 127.0.0.1 / ::1）——防开放转发/SSRF
   - Host 头仅接受 IP 字面量或 localhost——防 DNS 重绑定
3. **路由**：全部 loopback 围栏（非回环 403、方法不匹配 405）；health 路由
   `ROUTES.health` 必带；smoke 必须含 403/405 围栏用例。
4. **配置单一通道**（issue #110）：配置一律存官方 settings 存储——
   `installLanProxySettings` 注册 `dsh-lan-proxy` 命名空间，读 `scope.get()`、
   写经 loopback HTTP 配置路由（GET 快照 / PUT patch）转 `scope.update`/`replace`
   （清除证书路径等 unset 语义走 replace），热更新统一由 `scope.watch` 驱动；
   存量 `config.json` 由启动时一次性 marker 迁移收编（改名
   `config.json.migrated.bak`），不得复活任何自建配置文件读写或 RPC 配置端点。
   新增配置键须同步 schema 与 `FILE_CONFIG_VALIDATORS` 两处校验
   （迁移过滤与保存校验共用同一键集）。
5. **客户端契约**：路由常量与宿主 `src/index.ts` 的 `ROUTES` 单一来源（构建期
   `__DSH_ROUTES__` 注入）；客户端源码禁写 loader 痕迹（见 DEVELOPMENT.md §2）；
   React 走 externals：类型由根 devDep `@types/react` 提供（#834 起各包不再自备
   `react-shim.d.ts`），运行时由 dsh web 的 factory `require("react")` 注入，故只声明
   `peerDependencies.react` + optional。

## 验证（提交前全跑）

> 完成定义以根 [AGENTS.md 门禁矩阵](../../AGENTS.md) 为**单一事实源**：下列五条是该矩阵
> `pnpm gate:full` 档的真子集，本清单只作提交前自查，不替代该矩阵的分层门槛。本文件是新增
> 包级 `AGENTS.md` 的模板（根 AGENTS.md 指定），新包照此保留该指针。

```sh
pnpm build && pnpm test && pnpm contract && pnpm pack:check && pnpm typecheck
```

## 提交

Conventional Commits（如 `refactor(dsh-lan-proxy): ...`），中文 subject，禁 emoji；
安全语义变更须同步 README 的「安全模型」节与测试。
