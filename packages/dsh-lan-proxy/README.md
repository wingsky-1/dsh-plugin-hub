# @wingsky-1/dsh-lan-proxy
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-lan-proxy)](https://www.npmjs.com/package/@wingsky-1/dsh-lan-proxy)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

局域网访问 dsh web UI：在 `0.0.0.0:<port>` 监听，把 HTTP/HTTPS 与 WebSocket/wss
转发到回环 web 服务器（默认 `127.0.0.1:3080`）。

**简体中文** | [English](README.en.md)

## 一键安装

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

## 快速导航

[使用前须知](#使用前须知) · [安全模型](#安全模型) · [最短上手](#最短上手) · [常用配置](#常用配置) · [验证与排障](#验证与排障) · [详细参考](#详细参考) · [开发与架构](#开发与架构)

<a id="使用前须知"></a><a id="user-content-使用前须知"></a>
## 使用前须知

前提：已安装 DeepSeek Harness 且 `dsh web` 可正常启动（未全局安装 dsh 见下方「未全局安装 dsh」）。

- 重写 Host/Origin 以通过 /api 浏览器信任围栏
- 仅接受 IP 字面量或 localhost 的 Host 头（**DNS 重绑定防护**）
- HTTPS 默认并存（3443），证书可配置或自动生成自签名

<a id="安全模型"></a><a id="user-content-安全模型"></a>
## 安全模型

- **出站目标白名单（L1）**：`targetHost` 仅允许回环地址（localhost / 127.0.0.1 /
  ::1），配置层与运行时入口双重校验——**防止开放转发/SSRF**
- **DNS 重绑定防护**：只接受 Host 为 IP 字面量或 `localhost` 的请求，域名一律
  403/断开；IP 字面量在任何端口都安全
- **凭据面**：dsh settings RPC 仅回环可读写；通过本插件访问的远程设备在
  浏览器信任围栏内可读写服务器 settings（**含凭据类数据**）——确保你的局域网
  可信，或禁用该插件
- **桥接头透传**：WS 桥接的上游连接透传入站头（Cookie 等认证凭据——dsh
  0.1.2 起 `/api/remote.mux` 升级需 Cookie 认证，丢弃即 401 连不上），仅覆盖
  Host/Origin 为回环目标、剥离 hop-by-hop 与 WS 握手专有头；上游被 `targetHost`
  强制约束为回环，凭据只发往本机回环上游（不承诺跨进程隔离）。**压缩炸弹面**：桥接浏览器段
  permessage-deflate 解压存在放大点（LAN 内恶意客户端高压缩比帧 → 代理进程
  解压）——在「LAN 信任」威胁模型内可接受（与 injectToken 同一信任边界）
- **私钥权限**：自动生成的自签名私钥落盘 0600；一键 CA 的 CA 私钥 + 叶子私钥 + .bak 一律 0600（write + chmodSync 双保险），certs/ 目录 0700
- **证书下发面（issue #911）**：下发路由只读给公钥（loopback 围栏 + 仅 GET + 无 Cookie 要求）。只伺服首个 CERTIFICATE 块，误指私钥一律 404；响应禁缓存。无 CA 时一律 404（自签/孤叶子装了建不起信任，不下发）
- **一键 CA 动作面（issue #930）**：POST 只写（loopback 围栏 + POST 白名单 + settings 可写才可用）。CA 私钥文件名固定（ca-key.pem），永不进下发源；失败响应只出固定码（ca-generate-failed 等），路径与私钥原文只进服务端日志。默认轮换仅换叶子（CA 续用，已装设备零操作）；轮换 CA 为独立危险动作（已装设备信任全部失效，需逐台重装）。旧材料搬时间戳 .bak 只留最近 1 个
- **开放端口提醒**：0.0.0.0 监听对局域网所有设备可见
- **HTTP 响应压缩**：压缩在转发层完成，只作用于「本插件与局域网客户端之间」
  的链路，不触碰 dsh web 的响应生成；不新增可达数据面，仅增加少量 CPU 开销
  （可经 `httpCompressEnabled: false` 关闭）。health/标记路由的 loopback 围栏
  对**直连回环 web** 的请求生效；经本插件转发的请求按设计视为受信（见凭据面）。
  注意：health 响应携带的诊断元数据——`configDir` 绝对路径与压缩协商计数——
  会随转发原样到达局域网设备，对其可见
### injectToken 自动注入（issue #380）

dsh web 的浏览器会话认证（launch token
  + 持久签名 cookie）无法关闭，token 每次重启变化且只打印在本机终端——固定
  局域网设备拿不到实时 token。本插件经官方 connection 服务的**公开 API**
  `authenticatedUrl()` 动态读取当前 token，仅在铸造入口（`GET /`、无会话 cookie）
  自动补上：LAN 设备零操作进入。安全取舍与缓解：
  - **等效「信任整个局域网」**：开启后任何能网络到达本端口的客户端都免 token
    获得完整 dsh 控制权（bash 直通宿主机）。仅在可信家庭/办公内网开启；
    不可信网段务必关闭（设置卡片开关）。
  - **默认开启（维护者决策）**：业界同类先例（Home Assistant `trusted_networks`
    认证 provider、qBittorrent WebUI 「Bypass authentication for clients」）默认
    需显式配置；本插件按家用固定内网场景默认开启，以「启动横幅警示行 + 设置
    卡片常驻警示 + 本节说明」作缓解。
  - **关闭不吊销已发 cookie**：会话 cookie 有效期内（默认 30 天）已登录设备
    在关闭后仍可直接进入；需立即收回访问时清空 dsh credentials 存储。
  - **失效 cookie 自愈**：cookie 失效（credentials 重置等）的设备原本会陷入
    401 死锁（Max-Age 内浏览器不删 cookie、又拿不到新 token）；转发层在检测到
    上游 401 后自动带 token 重放一次，上游直接重铸 cookie，设备无感恢复。
  - **cross-site 残余面**：公网恶意页面对 `http://<LAN-IP>:3081/` 发起的跨站
    GET 可被白铸 cookie，但读不到响应（CORS opaque）、后续请求因
    `SameSite=Strict` 不携带 cookie、`POST /api` 被 sec-fetch-site 围栏拒绝——
    链条闭合；token 与 cookie 均不出现在浏览器地址栏/历史。
  - **不注入范围**：仅 `GET /` 且无 token 参数的请求；WebSocket、非根路径、
    已带 token 的请求、provider 不可用时全部原样透传（行为与未开启一致）。
    自建口令页（信任收窄为「知道口令」）为后续演进方向。
### ownsHostCompat 兼容注入（issue #856，默认关）

经官方 webServer 注入钩子向**非回环**页面声明 `ownsHost`，恢复 Host 设置持久化面与
「打开配置文件」动作。它伪造的是页面侧拓扑事实，不是服务端授权变化：`/api` 围栏、
launch token 与会话 cookie 认证保持不变；兼容开启后，LAN 页面与回环页面在界面上不再可区分。

- **配置入口**：Plugin Manager → dsh-lan-proxy → Configure。canonical row id 为
  `ui-dsh-lan-proxy`，keyed row 为 `@wingsky-1/dsh-lan-proxy#ui-dsh-lan-proxy`，
  官方 settings 条目也使用 `ui-dsh-lan-proxy`。
- **挂载边界**：配置页由 `plugins.row.config` 渲染，仅在 Host 服务 canonical settings 条目时
  注册。`compat-off` 或上游契约漂移时，非回环页面可能无法进入配置行。
- **可见性**：启动横幅与 `/api/dsh-lan-proxy/health` 显示宿主侧开关；页面加载时若兼容未生效
  或契约漂移，浏览器控制台给出独立告警，不依赖配置页。
- **恢复旁路（仅在行详情不可达时）**：可直接编辑 DSH 当前设置文档中的
  `ui-dsh-lan-proxy.ownsHostCompat`（宿主使用 `settings.yaml` 时，以「打开配置文件」显示的
  路径为准），或执行 `ssh -L 3080:127.0.0.1:3080 <主机>` 后访问
  `http://127.0.0.1:3080/`。两者都是恢复旁路，不是常规配置路径。

<a id="最短上手"></a><a id="user-content-最短上手"></a>
## 最短上手

> **安装即开端口**：本插件会在 `0.0.0.0:3081`（HTTP）与 `0.0.0.0:3443`（HTTPS）监听，局域网内所有设备都可访问你的 dsh web。不需要时请卸载（见后文卸载）。

### 安装插件（add）

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

### 访问

在可信局域网设备打开 `https://<服务器IP>:3443/`（或 `http://<服务器IP>:3081/`）。自签名证书首次访问需手动「继续访问」，详见 HTTPS 支持。

### 验证

在宿主机检查健康端点：

```sh
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health
```

<a id="常用配置"></a><a id="user-content-常用配置"></a>
## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 总开关（关闭后转发器停止监听） |
| `host` | `0.0.0.0` | 监听地址 |
| `port` | `3081` | HTTP 监听端口 |
| `httpsPort` | `3443` | HTTPS 监听端口 |
| `targetHost` | `127.0.0.1` | 回环上游主机（**仅允许回环地址**） |
| `targetPort` | 自动 | 上游端口（默认取 web 服务器实际绑定端口） |
| `httpsEnabled` | `true` | 是否并存 HTTPS |
| `tlsCertFile` / `tlsKeyFile` | 无 | 自定义证书（mkcert 等） |
| `tlsCaCertFile` | 无 | 自建 LAN CA 公钥（PEM，仅读） |
| `printBanner` | `true` | 启动时是否在终端打印监听横幅（LAN 访问地址等） |
| `wsBridgeEnabled` | `true` | 桥接总开关；关闭会失去保活与压缩。 |
| `wsCompressEnabled` | `true` | 是否对命中 `wsCompressPaths` 的 WebSocket 做压缩桥接（仅控制压缩，不影响桥接保活） |
| `wsCompressPaths` | `/api/remote.mux` | 参与 WebSocket 压缩的路径白名单（清空 = 桥接不压缩，保活不受影响） |
| `wsDeflatePolicy` | `{browser:true, uaDeny:[iPhone…]}` | 浏览器压缩策略与 UA 排除规则。 |
| `httpCompressEnabled` | `true` | 转发层 gzip/Brotli 压缩开关。 |
| `httpCompressLevel` | `1` | gzip 与 Brotli 共用的 0..3 档位。 |
| `injectToken` | `true` | LAN 免 token 直入，默认开；见安全模型。 |
| `ownsHostCompat` | `false` | 伪造页面侧宿主事实位，默认关；见安全模型。 |

配置页入口：**Plugin Manager → dsh-lan-proxy → Configure**（保存即热更新）。

> 非回环 LAN 地址默认不提供持久化设置面，Configure 按钮按 DSH 安全策略隐藏；请从 `127.0.0.1:3080` / `127.0.0.1:3081` 或 SSH 回环隧道管理。只有在可信 LAN、明确接受共享控制面风险时，才开启 `ownsHostCompat` 恢复远程设置入口。

### 配置存储（单一通道）

- 全部配置存于 dsh 官方 settings 存储；canonical 条目 id 为 `ui-dsh-lan-proxy`，
  落盘位置由宿主统一管理。组合层 `cordis.patch.yml` 的 config 作为 base 层生效；
  热更新由官方 `scope.watch` 驱动，无需重启。

#### RC7 旧 settings section 迁移

DSH 0.1.7-rc.1 会把旧的 `~/.dsh/settings.yaml` 改名为 `settings.yaml.imported`。
这个文件是已消费旧文档的**审计副本**，只保留证据，不是当前配置源；不要把整个
`settings.yaml.imported` 再复制到 profile。插件可编辑字段会由迁移写入 active profile 的
`~/.dsh/profiles/<profile>/cordis.patch.yml`，canonical id 为 `ui-dsh-lan-proxy`。

自动迁移只消费旧 `dsh-lan-proxy` section 中当前 Config schema 认可的字段，按
`settings.yaml.imported < settings.yaml < 当前 canonical user` 合并；旧自建
`config.json`、未知顶层键和其它已废弃字段不会写入 canonical patch。迁移完成 marker 是
插件私有目录中的 `settings.migrated`（版本 `1`）。canonical 写入前先创建 `settings.migrated.pending`
receipt，成功后 promote 为完成 marker；未知失败恢复只完成 marker、不重放旧值，
避免 DSH `unset` 后把用户已清除的值写回；只有明确的 revision 冲突才清理 receipt 并重试。

<details>
<summary>旧 config.json 迁移</summary>

- 本插件不再维护自建 `~/.dsh/lan-proxy/config.json`。升级后首次启动会自动把
  存量 config.json 一次性迁移进官方存储：原文件原子改名保留为
  `config.json.migrated.bak` 备份；若写入官方存储失败会自动还原改名、下次
  启动重试；若进程在写入完成前退出（中断），下次启动检测到备份残留会自动
  从备份重放写入并以日志提示。确认运行正常后可手动删除该备份。
  此后手改 config.json **不再生效**。

</details>

### 配置项细则

#### `wsBridgeEnabled`

WebSocket 桥接总开关（issue #552）：`true` = 所有 WS 升级一律走「终结 + 桥接」（保活基座：ws 库自动代答上游 Ping + 半开探活）；`false` = TCP 字节透传（显式放弃保活与压缩，移动端切后台可能被上游心跳判死而频繁断连重连，见「WebSocket 压缩」节）

#### `wsDeflatePolicy`

WS 压缩协商策略：`browser` 为 false 全局关压缩；`uaDeny` 为不协商压缩的 UA 片段列表（iOS Safari 默认拦截，见「WebSocket 压缩」节）

#### `httpCompressEnabled`

HTTP 响应压缩总开关（转发层对可压缩响应协商 gzip/Brotli；Brotli 生效条件见「HTTP 响应压缩」节，合并自 dsh-gzip）

#### `httpCompressLevel`

压缩档位预设 0..3：`0` 默认 / `1` 低（gzip 1 / br 2，最快）· `2` 中（gzip 5 / br 5，均衡）/ `3` 高（gzip 9 / br 9，最高压缩比），gzip 与 Brotli 两侧参数同时按下发；旧配置整数 4..9 自动迁移为 3

#### `injectToken`

自动注入启动令牌（issue #380）：LAN 设备首次访问 `GET /` 由转发层自动补当前 token 铸造会话 cookie，固定设备免手工拿 token；带失效 cookie 的请求在上游 401 后自动重放自愈。安全语义见「安全模型」

#### `ownsHostCompat`

向非回环页面声明 `ownsHost`（issue #856）：恢复 Host 设置持久化面与「打开配置文件」动作；远程页与本机页在界面上不再可区分。默认关，配置入口与恢复旁路见「安全模型」

<a id="验证与排障"></a><a id="user-content-验证与排障"></a>
## 验证与排障

```sh
# 健康检查（回环；含压缩配置与生效状态/协商计数）
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health

# 合并版压缩标记路由（回环）
curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/compression

# 局域网访问（在另一台设备上）
curl http://<本机局域网IP>:3081/api/dsh-lan-proxy/health
```

### 已知限制

- HTTPS 自签名证书由内置库生成，无外部命令依赖（未配置证书文件且生成失败时，HTTPS 通道自动降级关闭）
- 换网段导致 IP 变化时，自签名证书需重新生成或更新设置（证书文件路径）
- WS 桥接默认对所有 WebSocket 生效（保活基座）；压缩仅对命中 `wsCompressPaths`
  的路径生效（多一跳、额外压缩 CPU）。桥接为代理解析终结：子协议与 close 码
  不向另一端保真（dsh 客户端不依赖，实测零影响）
- `wsBridgeEnabled=false` 时全部 WS 走透传（省一跳 CPU），但移动端切后台
  >4~6s 会被上游心跳判死而频繁断连重连——仅建议无移动端场景使用

<a id="详细参考"></a><a id="user-content-详细参考"></a>
## 详细参考

### WebSocket 桥接与压缩（wss 事件流）

- **桥接是默认基座（issue #552）**：`wsBridgeEnabled` 开启（默认）时，**所有**
  WebSocket 升级一律走「终结 + 桥接」——lan-proxy 用 ws 库分别连接浏览器段与
  DSH 段、双向转发帧。桥接提供两项**与压缩无关**的基础能力：
  - **上游 Ping 自动代答**：dsh 上游（api-gateway）对 remote.mux 每 2s 发一帧
    WS Ping、连续 2 周期（约 4~6s）无 Pong 即 `terminate()`。桥接的上游连接由
    ws 库自动回 Pong——手机切后台/息屏/短暂冻结不再触发上游判死，连接在亮屏后
    继续可用（不再「频繁断开→重连」）。
  - **半开探活（issue #268）**：桥接对两端各自独立每 30s 发一帧 WS ping；一帧
    ping 在下一个周期内未收到 pong（即约 30~60s 无响应）即判定半开连接并强拆
    该端——close/error 语义由此在半开下也能成立。判定强拆时输出 warn 日志
    `ws-bridge half-open detected, terminating (intervalMs=…)`。
- **压缩是桥接上的可选增强**：命中 `wsCompressPaths`（默认 `/api/remote.mux`
  ——dsh 0.1.2 起 api-gateway 拥有的 Remote 流 mux 端点，取代旧
  `/api/events.mux`、`/api/events.host`）且 `wsCompressEnabled` 开启时，浏览器段
  协商 permessage-deflate（浏览器自动解压）、DSH 段明文，再双向桥接转发。
  收益：remote.mux 承载大流量帧，permessage-deflate 实测约省 **75~79%**。
- **清空压缩白名单 / 关闭压缩开关不再丢保活**（issue #552）：`wsCompressPaths=[]`
  或 `wsCompressEnabled=false` 仅关闭压缩，桥接（Pong 代答 + 探活）保持生效。
- DSH 服务端即使未来自身开启 permessage-deflate，这里 DSH 段固定不协商压缩，
  两段各自独立，**不会双重压缩、不冲突**。
- **桥接非字节透明**：桥接是代理解析终结（非 TCP 透传），子协议
  （Sec-WebSocket-Protocol）协商与 close 码不向另一端保真（dsh 客户端当前
  不依赖这两者，实测零影响）；对通用 WS/未来端点以此语义为准。
- **显式关闭桥接**（`wsBridgeEnabled=false`）：全部 WS 走 TCP 字节透传
  （省一跳 CPU），但失去 Pong 代答与探活——移动端切后台 >4~6s 会被上游心跳
  判死断开重连，仅建议在无需移动端的场景使用。

### HTTP 响应压缩（Brotli/gzip 自适应，合并自 dsh-gzip）

- v0.1.10 起，原独立插件 dsh-gzip（源码已自本仓移除）的 HTTP 响应压缩能力已合并进本插件，
  在**转发层**实现（成熟开源库 [compression](https://www.npmjs.com/package/compression)
  中间件，构建期内联进产物）：经本插件访问时，对 `/api`（RPC）、
  `/plugins`（客户端 bundle）与静态资源/index.html 等可压缩响应（JSON / 文本）
  自动协商压缩；SSE（text/event-stream）、zip 导出、已编码响应、HEAD、
  带 Range 的请求、小于 1KB 的响应原样透传。
- **Brotli 的实际生效条件（实测口径）**：dsh 自身的 web 服务器自带 gzip 压缩
  （`compression: gzip`），且只协商 gzip。因此这条链路上有两种情形：

  | 客户端声明 `Accept-Encoding` | 上游行为 | 经本插件最终返回 |
  |---|---|---|
  | `br, gzip`（主流浏览器） | gzip | gzip（响应已编码，本层让位不重压） |
  | `gzip` | gzip | gzip（同上） |
  | `br`（仅声明 br） | 原文 | **br** |

  即：只有当上游未压缩且客户端只声明 br 时，本层的 Brotli 才真正生效。主流浏览器
  都同时声明 gzip，故这条链路上拿到的是上游 gzip、**拿不到 Brotli 的额外压缩率**；
  该情形仍远优于不压缩（同一响应实测 322900 → 5065 字节）。两层不会重复压缩。
- 收益：会话历史等大 JSON 响应（4~13MB 未压缩）经远程/慢链路访问时常触发
  浏览器 RPC 30s 超时「历史加载失败」；压缩后约 ~1.2MB，隔离环境实测由
  ~36s 降到 ~3s。
- 实现位置在转发器自己的监听链上，不修改 dsh web 与任何其他插件的运行时行为；
  `httpCompressEnabled: false` 关闭本层压缩（当客户端同时接受 gzip 时，上游自带
  gzip 仍会压缩响应，故该开关不改变这类响应的线上体积）。注意：直连回环 web
  （本机浏览器访问 `127.0.0.1:3080`，不经本插件）的流量不在压缩面内——回环链路
  无需压缩。
- **从 dsh-gzip 迁移**：升级本插件并确认压缩生效后，卸载独立 gzip 包：

  ```sh
  dsh plugin --profile web update @wingsky-1/dsh-lan-proxy    # 需 >= 0.1.10
  curl -s http://127.0.0.1:3081/api/dsh-lan-proxy/health      # 回环校验：httpCompressMounted 为 true 再继续
  dsh plugin --profile web remove @wingsky-1/dsh-gzip
  # 重启 dsh web 生效
  ```

- 存量 gzip@0.1.9（无检测逻辑）与本插件双装时，因 content-encoding 检查只会
  压缩一次（已实测任意装配顺序均单层），不会损坏响应；建议尽快卸载以免
  health 诊断口径混淆。

### HTTPS 支持

- **证书来源（两级）**：① 配置 `tlsCertFile`/`tlsKeyFile`（正式证书或 mkcert
  本地 CA，浏览器零警告）；② 自动生成自签名证书（内置 selfsigned 库生成并缓存到
  `<DSH_HOME>/@wingsky-1/dsh-lan-proxy/`（旧 lan-proxy 目录首次启动自动迁入），私钥权限 0600，无需宿主机 openssl）
- 自签名证书首次访问需手动"继续访问"；内网设备零警告推荐自建 LAN CA（一台设备装一次 CA，见下）
- **一键生成本地 CA（issue #930）**：设置页“局域网访问”卡片点“一键生成本地 CA”，即签发 10 年 CA + 398 天叶子并写入托管目录 `<DSH_HOME>/@wingsky-1/dsh-lan-proxy/certs/`（CA 公钥 `ca-cert.pem` / 私钥 `ca-key.pem` / 叶子 `leaf-cert.pem` + `leaf-key.pem`），三键自动回填。默认“轮换叶子证书”仅换叶子（CA 不变，已装设备零操作）；“轮换 CA”为危险动作。不想走 UI 时可用 mkcert 自建 CA（零代码并存路径，hint 同上）
- **移动设备安装证书（issue #911，#930 Phase 1 无 CA 不下发）**：配 tlsCaCertFile（CA 公钥）后，设置页下载直链即下发 CA（须用浏览器直接点开链接）。无 CA 时下载链接一律 404（自签模式与自定义孤叶子都不下发：装了建不起信任）：先在设置页一键生成本地 CA，或配置 CA 公钥后重试。iPhone 装描述文件后去证书信任设置打开信任；Android 在设置安全项安装 CA 证书；Windows 双击装进受信任的根证书颁发机构

### 卸载插件（remove）

```sh
dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
```

### 更新插件（update）

```sh
dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

> 安装 / 卸载 / 更新后都需**重启一次** `dsh web`（bundle 层只在启动时组合）生效。

<details>
<summary>低频安装变体：指定版本与 npx</summary>

### 指定版本号（@version）

省略 `@版本号` 即安装默认 latest（推荐）。仅当 registry 尚未同步到最新、或最新版在你的环境有问题时，在包名后追加 `@版本号`：

```sh
dsh plugin --profile web add @wingsky-1/dsh-lan-proxy@<版本号>
```

### 未全局安装 dsh

若本机没有全局 `dsh` 命令，用 `npx` 临时拉起（底层调用 `pnpm`，仍需本机装好 `pnpm` 与 `Node.js`）：

```sh
npx @deepseek-ai/dsh plugin --profile web add @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
npx @deepseek-ai/dsh plugin --profile web update @wingsky-1/dsh-lan-proxy
```

</details>

<a id="开发与架构"></a><a id="user-content-开发与架构"></a>
## 开发与架构

原理与运行机制见 [TOGAF 4A 架构文档](../../docs/architecture/dsh-lan-proxy.md)（BA 业务 / AA 应用 / DA 数据 / TA 技术四视图）。

测试单份维护、变异自动覆盖：用例按层归在 `test/{unit,integration,e2e,client}/`，其中单元与集成层直接 `import` 源码（`src/**`，白盒直连 impl），e2e 冒烟跑 `lib/` 产物（`import "../../lib/index.js"`）；stryker 经 lib→src hook 对同一份用例做变异，无需手工同步副本。

<a id="配置契约附录"></a><a id="user-content-配置契约附录"></a>
## 配置契约附录

| 键 | 宿主默认 | 客户端展示缺省 | patch 声明 |
|---|---|---|---|
| `port` | `3081` | `3081` | 未声明 |
| `httpsPort` | `3443` | `3443` | 未声明 |
| `host`／`targetHost` | `"0.0.0.0"`／`"127.0.0.1"` | 无此键 | 未声明 |
| `targetPort` | 无默认值，跟随回环 web 实际端口 | 无此键 | 未声明 |
| `injectToken` | `true` | `true` | 未声明 |
| `ownsHostCompat` | `false` | `false` | 未声明 |
| `enabled`／`httpsEnabled`／`printBanner`／`wsBridgeEnabled`／`wsCompressEnabled`／`httpCompressEnabled` | `true` | `true` | 未声明 |
| `httpCompressLevel` | `1`（0..3） | `1` | 未声明 |
| `wsCompressPaths`／`wsDeflatePolicy`／`tlsCertFile`／`tlsKeyFile` | `["/api/remote.mux"]`／`{browser:true, uaDeny:[iPhone,iPad,iPod]}`／无默认值 | `["/api/remote.mux"]`／无此键／`""` | 未声明 |

宿主默认来自 `src/server/shared/defaults.ts` 的 `DEFAULT_OPTIONS` 与 `src/server/shared/deflate.ts` 的 `DEFAULT_DEFLATE_POLICY`，经 `src/server/config/impl/model.ts` 的 `Config`／`DEFAULT_CONFIG` 生效；客户端缺省来自 `src/client/shared/defaults.ts` 的 `DEFAULTS`；`cordis.patch.yml`（`ui-dsh-lan-proxy`）独立／聚合行均不带 `config`。`injectToken` 开启等效信任整个局域网，`ownsHostCompat` 开启即向非回环页面声明 `ownsHost`，语义见「安全模型」。以上代码为单一事实源，文档与代码不一致时以代码为准。

## License

MIT
