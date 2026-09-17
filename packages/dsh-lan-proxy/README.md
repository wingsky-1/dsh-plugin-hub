# @wingsky-1/dsh-lan-proxy
[![npm](https://img.shields.io/npm/v/@wingsky-1/dsh-lan-proxy)](https://www.npmjs.com/package/@wingsky-1/dsh-lan-proxy)
[![GitHub Releases](https://img.shields.io/github/v/release/wingsky-1/dsh-plugin-hub)](https://github.com/wingsky-1/dsh-plugin-hub/releases)

局域网访问 dsh web UI：在 `0.0.0.0:<port>` 监听，把 HTTP/HTTPS 与 WebSocket/wss
转发到回环 web 服务器（默认 `127.0.0.1:3080`）。

**简体中文** | [English](README.en.md)

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
- **私钥权限**：自动生成的自签名私钥落盘 0600
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

经官方 webServer index 注入钩子，
  向**非回环**页面注入一段自条件脚本，令其声明
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`。这是**伪造上游拓扑事实位**——
  页面本不该携带该 global。它**不是服务端授权变化**：`/api` 围栏、launch token 与
  会话 cookie 认证完全不变，变的只是页面侧事实位。
  - **被解锁的具体行为**：① 设置持久化从 memory scope 恢复为 host scope，写入
    `<DSH_HOME>/settings.yaml`（文件不存在时以 `flag: "wx"` 新建）；② 宿主原生
    「打开配置文件」动作（设置页可唤起宿主打开该文件）。
  - **远程页与本机页在界面上不再可区分**：`isLoopback` 是「本机 / 远程」的唯一信号，
    兼容模式下 LAN 页面与 `127.0.0.1` 页面同值。
  - **注入边界**：脚本元素对所有经本插件服务的 index.html 都会落（含回环 authority
    页面），但脚本是自条件的——页面已持有 `__DSH_TRANSPORT__`（desktop-host 等自带
    transport 的组合不受影响）或 authority 为回环（localhost / [::1] / 127/8）时**立即
    早退**，既不写 transport 也不落 marker。「回环页拿到了 script 元素」与「回环页被改动」
    是两件事，后者不会发生。
  - **关闭方法**：设置 → 插件 → dsh-lan-proxy，关闭「向非回环页面声明 ownsHost（兼容）」
    （组合层配置为 `ownsHostCompat: false`），关闭后重新加载页面即恢复原状。
  - **零伪造替代路径**：`ssh -L 3080:127.0.0.1:3080 <主机>` 后访问
    `http://127.0.0.1:3080/`——页面 authority 本身就是回环，设置持久化面天然可用，
    不需要冒充任何拓扑事实。
  - **失效可见性**：判定是**四态**（本机页 / 兼容模式生效 / 上游契约漂移 / 开关关闭）。
    两个故障态都不依赖设置卡片，可见面有三处，但三者能看到的范围不同：
    ① **devtools 控制台**——页面加载时（`apply` 最前面）打一条 `[dsh-lan-proxy]` 告警，
    每次装配一次、不在渲染期重复，故不刷屏；它也不依赖设置面是否可用，是唯一能反映
    **页面侧事实**（注入是否真的生效）的故障态出口；② **启动横幅**的
    `ownsHostCompat: ON/OFF` 行；③ `GET /api/dsh-lan-proxy/health` 的
    `ownsHostCompat` 字段。②③ 只反映宿主侧开关，回答不了「上游是否已漂移」。设置卡片
    底部另常驻一行四态判定，但只在卡片挂载时可见（见下条）。
  - **已知限制（两个故障态在页面上不可达）**：卡片挂在 `settings.plugin.item` 插槽上，
    而该插件列表只在 settings scope 可用时才有条目——上游按 `isLoopback` 把非回环页面的
    设置面降级为 memory scope 时，插件列表为空、卡片不挂载（dsh-client-ui-settings-plugins
    仅在 namespaces 非空时 renderSlot）。关键在于：**同一枚 `isLoopback` 信号既决定卡片
    是否挂载、又决定四态判定的结果**，于是 `contract-drift`（上游删改/重排 `ownsHost`
    谓词、注入失效）与 `compat-off`（开关关闭）这两个最需要被看到的态，恰恰在页面上没有
    承载面；实测（非回环 authority + 开关关）设置插件列表为空、卡片不挂载，卡片底部那行
    判定自然也不出现。故这两个态的可见面收敛为上面 ① 的 devtools 告警（页面侧漂移）+
    ②③ 的横幅与 health 字段（宿主侧开关）。需要改开关时只能在宿主侧：`settings.yaml` 的
    `dsh-lan-proxy.ownsHostCompat`、profile 的 `cordis.patch.yml` base 层，或用回环
    浏览器打开设置页。

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
| `printBanner` | `true` | 启动时是否在终端打印监听横幅（LAN 访问地址等） |
| `wsBridgeEnabled` | `true` | 桥接总开关；关闭会失去保活与压缩。 |
| `wsCompressEnabled` | `true` | 是否对命中 `wsCompressPaths` 的 WebSocket 做压缩桥接（仅控制压缩，不影响桥接保活） |
| `wsCompressPaths` | `/api/remote.mux` | 参与 WebSocket 压缩的路径白名单（清空 = 桥接不压缩，保活不受影响） |
| `wsDeflatePolicy` | `{browser:true, uaDeny:[iPhone…]}` | 浏览器压缩策略与 UA 排除规则。 |
| `httpCompressEnabled` | `true` | 转发层 gzip/Brotli 压缩开关。 |
| `httpCompressLevel` | `1` | gzip 与 Brotli 共用的 0..3 档位。 |
| `injectToken` | `true` | LAN 免 token 直入，默认开；见安全模型。 |
| `ownsHostCompat` | `false` | 伪造页面侧宿主事实位，默认关；见安全模型。 |

GUI 设置入口：设置 → 插件 → 「局域网访问」卡片（保存即热更新）。

### 配置存储（单一通道）

- 全部配置存于 dsh 官方 settings 存储（`settings.register` 注册的
  `dsh-lan-proxy` 命名空间，落盘在宿主统一管理的 settings 文档中），组合层
  `cordis.patch.yml` 的 config 作为 base 层生效；热更新由官方 `scope.watch`
  驱动，无需重启。
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

向非回环页面声明 `ownsHost`（issue #856）：**伪造上游拓扑事实位**，解锁设置持久化落盘（`<DSH_HOME>/settings.yaml`）与宿主「打开配置文件」动作；远程页与本机页在界面上不再可区分。默认关，取舍、关闭方法与 `ssh -L` 零伪造替代路径见「安全模型」

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
  `<DSH_HOME>/lan-proxy/`，私钥权限 0600，无需宿主机 openssl）
- 自签名证书首次访问需手动"继续访问"；内网设备零警告推荐 mkcert

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

## License

MIT
