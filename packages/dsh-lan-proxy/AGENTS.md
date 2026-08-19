# AGENTS.md — dsh-lan-proxy 包规则

> 本文件是 `@wingsky-1/dsh-lan-proxy` 的**包级规范**（叠加层）。改动本包
> `src/`、`test/`、`cordis.patch.yml`、`package.json` 前必读。上层规则见仓库根
> `AGENTS.md`（硬性）与 `docs/DEVELOPMENT.md`（权威详细版）。

## 定位

局域网访问 dsh web UI 的零依赖转发器：在 `0.0.0.0:<port>`（默认 HTTP 3081、
HTTPS 3443）监听，把 HTTP/HTTPS 与 WebSocket/wss 转发到回环 web 服务器
（默认 `127.0.0.1:3080`），重写 Host/Origin 以通过 /api 浏览器信任围栏。
端口/证书/压缩路径等均可经 GUI 设置面板或 config.json 热更新。

## 目录结构

- `src/index.ts` — 宿主端 cordis service（薄壳 apply：解析配置 → 注册 → 收集
  disposer；所有清理统一写在 `ctx.effect` 返回的 disposer 里）
- `src/proxy.ts` — 转发器核心 `createLanProxy`（HTTP/HTTPS/WebSocket 桥接、
  Host 重写、DNS 重绑定防护、wss 压缩桥接）；业务逻辑导出纯函数可单测
- `src/cert.ts` — TLS 证书（配置证书加载 / 自签名生成并缓存到
  `<DSH_HOME>/lan-proxy/`，私钥落盘 0600）
- `src/client/` — 客户端（干净模块：`index.ts` + `style.css` + `css.d.ts` +
  `react-shim.d.ts`）
- `test/smoke.ts` — smoke（fake ctx，无网络）
- `cordis.patch.yml` — patch（id `ui-lan-proxy`）

## 改动前必守（本包特有）

1. **改 `src/` 必须 build 才生效**：dsh 经 profile 直读 `lib/` 产物，不自动编译。
   `lib/` 是构建产物，禁止手改（build 会清空重建）。
2. **转发安全红线**（运行时与配置层双重校验，改动时不得放宽）：
   - `targetHost` 仅允许回环地址（localhost / 127.0.0.1 / ::1）——防开放转发/SSRF
   - Host 头仅接受 IP 字面量或 localhost——防 DNS 重绑定
3. **路由**：全部 loopback 围栏（非回环 403、方法不匹配 405）；health 路由
   `ROUTES.health` 必带；smoke 必须含 403/405 围栏用例。
4. **配置热更新**：config.json watch（tmp+rename 原子写）+ GUI settings 命名空间
   （`installSettingsNamespace`）。新增配置键须同步 schema 与
   `FILE_CONFIG_VALIDATORS` 两处校验。
5. **客户端契约**：路由常量与宿主 `src/index.ts` 的 `ROUTES` 单一来源（构建期
   `__DSH_ROUTES__` 注入）；客户端源码禁写 loader 痕迹（见 DEVELOPMENT.md §2）；
   React 走 externals（`react-shim.d.ts` + peer optional）。

## 验证（提交前全跑）

```sh
pnpm build && pnpm test && pnpm contract && pnpm pack:check
```

## 提交

Conventional Commits（如 `refactor(dsh-lan-proxy): ...`），中文 subject，禁 emoji；
安全语义变更须同步 README 的「安全模型」节与测试。
