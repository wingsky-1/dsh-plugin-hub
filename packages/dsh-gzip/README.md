# @wingsky-1/dsh-gzip
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-gzip)](https://www.npmjs.com/package/@wingsky-1/dsh-gzip)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

> ⚠️ **本包进入退役流程**：HTTP 响应压缩功能已合并进
> [@wingsky-1/dsh-lan-proxy](../dsh-lan-proxy)（>=0.1.10），由 lan-proxy 一个包统一处理
> 「转发 + 压缩」。请升级 lan-proxy 并卸载本包：
>
> ```sh
> dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
> dsh plugin --profile web remove @wingsky-1/dsh-gzip
> # 重启 dsh web 生效
> ```
>
> v0.1.10 为最终兼容版：检测到合并版 lan-proxy（标记路由
> `/api/dsh-lan-proxy/compression`）时跳过自身安装并 warn 提示卸载；npm 包已标记
> deprecated，源码将在后续版本周期删除。

DSH Web GUI 的响应 gzip 压缩插件：为远程 / 低带宽链路开启 `/api` 响应、静态
资源（`/assets/*` 与 index.html）以及插件客户端 bundle（`/plugins/<pkg>/client.js`）
的 gzip 压缩，解决「历史加载失败：The user aborted a request.（internal）」的
问题并显著减小前端资源传输体积。

## 为什么需要

DSH Web GUI 加载会话历史时，一页历史可能包含全部流式 chunk 事件，响应体可达
4~13MB 且服务端默认不压缩；浏览器侧 RPC 又有 30s 硬超时。在低带宽链路
（easytier / ZeroTier / Tailscale / 移动网络）上会直接超时失败。

本插件在服务端对可压缩的响应做 gzip 压缩：同一页历史压缩后约 1.2MB，实测加载
时间由约 36s 降到约 3s（隔离环境）；前端主 bundle（~744KB）与各插件 client.js
压缩后约为原体积 1/3~1/4。

## 安装

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-gzip
```

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-gzip
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-gzip
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-gzip@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-gzip
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-gzip
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-gzip
```

## 验证

```sh
# 1. 健康检查（回环）
curl -s http://127.0.0.1:3080/api/dsh-gzip/health
# → {"ok":true,"plugin":"dsh-gzip","mounted":"replace","handlers":{"api":"replace","plugins":"replace","fallback":"replace"},...}

# 2. 响应头带 content-encoding: gzip
curl -s -D - -o /dev/null -X POST http://127.0.0.1:3080/api/session.list \
  -H "Content-Type: application/json" -H "Accept-Encoding: gzip" \
  -d '{"type":"client-request","rpcId":"test","method":"session.list","payload":{}}' \
  | grep -i content-encoding
```

`mounted` 反映 `/api` 的实际接管方式（`replace` / `register-patch`）；
`handlers` 分别报告 api / plugins / fallback 三个接管面的状态，见下方
「工作原理」。

## 工作原理

- **压缩条件**：请求 `Accept-Encoding` 协商 gzip（q=0 视为拒绝）且响应
  content-type 可压缩（JSON / JSON 系 / text）且未自带 `content-encoding`。
- **接管范围（多分支、无时序依赖）**：
  - 已注册的 **prefix 命名路由**全量接管（含 `/api`、`/plugins` 及未来第三方
    prefix）——直接替换 `webServer.prefixes` 中对应 route.handler（运行时替换
    立即生效）；
  - **exact 路由同样接管**（`webServer.exact`，`DshRoute.kind:"exact"`）——与
    prefix 一致地套用 gzip 包装，解决插件常用 exact 路由（history 大 JSON、
    各插件 health、web-file-preview 文件预览等）不被压缩的问题；
  - **fallback 席位**接管（`webServer.fallback`）——覆盖 `/assets/*` 静态资源、
    `/` 与 SPA fallback 的 index.html；
  - `register` / `registerFallback` patch 仅作兜底，覆盖本插件先装配或后续重新
    注册的情形。
- **压缩级别可配置**：默认 level 1（静态文本场景 3~6ms/文件，压缩率约 −66~−77%）；
  配置 `level`（1..9）可调，非法值自动归一。
- **实例级遮蔽**：writeHead / write / end 仅在本请求的 ServerResponse 实例上
  替换，不动任何 prototype，请求结束自然释放；gzip 背压与 res 的 drain 事件
  桥接。

## 安全模型

- **豁免原样透传**：SSE（`text/event-stream`）、zip 导出、**HEAD 请求**（无
  body）、**带 `Range` 的请求**（保留范围语义）、未协商 gzip、已自带
  `content-encoding`、不可压缩 content-type（`application/octet-stream`、
  `image/*` 等）——一律不压缩、原样透传。核心保险是 `content-type` 白名单判断，
  与路由 is exact 还是 prefix 无关。
- **只作用于响应体**：不做任何缓存语义（不补 Cache-Control / ETag）；健康检查
  路由 loopback 围栏（非回环 403 / 方法错 405），仅回环可访问。
- **无全局副作用**：卸载恢复被替换的 prefix / exact handler、fallback 与
  register / registerFallback（replace 场景身份级恢复）；wrap 幂等（HMR 重载后
  二次 apply 不重复包裹）；`enabled: false` 时不注册任何东西。
- **依赖非公开字段**：主挂点读取 `webServer.prefixes`、`webServer.exact` 与
  `webServer.fallback`
  （实例公开字段但非官方 API），`registerFallback` 亦非官方方法（判存在性后
  patch）。上游改结构时自动退化到备用挂点，若时序不利则表现为「不压缩、不报
  错」——安全降级，可用 health 路由诊断 `handlers` 状态。

## 定位

过渡方案：根治在上游（历史响应瘦身 / 官方压缩 / 超时策略），上游修复后本插件
自然退场；即使失效也只是「不压缩」，不会破坏任何功能。

## 开发

```sh
# 源码在 src/*.ts，改后必须 build（dsh 直接 import lib 产物）
pnpm --filter @wingsky-1/dsh-gzip build
node test/smoke.ts
```

冒烟测试覆盖：q 值解析、SSE / 已编码 / **HEAD / Range** 豁免、真实 zlib 压缩
解压一致、level 归一与生效、prefix 全量接管（/api、/plugins）、fallback 接管
与 registerFallback 兜底、非 /api 路由不受影响、卸载恢复、health 路由（GET 200 /
POST 405 / 非回环 403 且含 handlers）、`enabled: false` 不注册。

## License

MIT。压缩包装逻辑借鉴上游 [040822/dsh-gzip](https://github.com/040822/dsh-gzip)（MIT）。
