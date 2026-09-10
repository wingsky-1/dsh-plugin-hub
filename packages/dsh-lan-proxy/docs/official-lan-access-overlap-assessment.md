# dsh 官方 LAN 访问能力与 lan-proxy 的重叠评估（结论：维持现状，不做薄化）

> **关联**：无线程，源于会话评估（维护者直接就「dsh 0.1.5 的 `--trusted-host` 是否已能
> 替代本插件部分能力」提问，本次成文归档）。
>
> **定位**：本文件记录一次**能力替代性评估**的结论与证据，供后续 dsh 升级评估复用。
> 它不是插件行为契约，不作为 README 的承诺面；文中对官方实现的描述以评估时的 dsh
> 版本为准，dsh 升级后须按「七、重新评估触发条件」复核。
>
> **验证基线**：dsh `0.1.5-rc.1`（与本仓 `pnpm-workspace.yaml` catalog 的适配基线
> 一致）。官方侧观察对象为本机安装件
> `~/.local/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/`，
> 引用的行号即该安装件 `lib/*.js`（已构建产物）行号，跨 dsh 版本会漂移。
>
> **证据口径**：每条结论标注「实测」或「源码判读」。实测用临时 `DSH_HOME`
> （`mktemp -d`）+ 独立端口 3099 + 真实 curl 完成，未触碰正在运行的 3080 GUI，
> 也未改动任何 profile；其中 4.1 的对照实验另用一个端到端脚本：上游以等价中间件
> 复现官方 gzip 逻辑，转发层用真实 `createLanProxy` 构建产物，两者均只监听回环。
> 源码判读指只读阅读上述安装件与 `packages/dsh-lan-proxy/src/`。

---

## 一、结论摘要

1. **官方 `--trusted-host` 只是信任白名单，不是开放端口的手段**。它无法单独让局域网
   设备访问 GUI——bind 仍留在回环，局域网请求到不了进程。（实测）
2. **官方当前不能替代 lan-proxy，且不是「更安全地做同一件事」**：要让官方方案在
   局域网可用，必须绕过 CLI 对 `--host 0.0.0.0` 的硬拦截（改 profile patch），
   其结果是 dsh 本体直接监听全网卡、防线只剩 token/cookie，比代理层语义更薄。
   （实测 + 源码判读）
3. **lan-proxy 的主体价值官方没有对应实现**：HTTPS/自签证书、WebSocket 桥接保活
   （Pong 代答 + 半开探活，移动端切后台不断连）、WS permessage-deflate 压缩。HTTP 响应
   压缩一项需要修正定位：官方 webserver **自带 gzip**（实测直连 3080 响应头
   `Content-Encoding: gzip`），本插件在这条链路上提供的是「Brotli + 档位控制」。关键
   限制是 Brotli 只在「上游未压缩且客户端仅声明 br」时生效，而主流浏览器同时声明
   gzip，故实际拿不到 Brotli 的额外压缩率（见 4.1，已端到端实测）。
4. **唯一真实重叠项是「Host 信任」这一层**，且两者方向相反：官方是「声明才放行」，
   本插件是「重写为回环 + 自守 IP 字面量」。把这一层做薄不能减少插件复杂度，只会
   在保留其余能力的同时更换一层已验证的安全语义。
5. **决策：维持 lan-proxy 现状，不因官方 `--trusted-host` 做能力薄化**。重新评估的
   触发条件见第七节。

---

## 二、官方实现拆解

### 2.1 `--trusted-host` 的语义

- CLI 定义：`@deepseek-ai/dsh-web-app/lib/startup.js:22`
  —— `extra authority the /api browser-trust fence accepts (host or host:port; repeatable)`。
- 收编进服务：同文件 `:46`，写入 `webStartup.trustedHosts`。
- 最终栅栏值：`@deepseek-ai/dsh-web-app/lib/index.js:83-89` `resolveLanTrust(bindHost, extra)`
  —— 返回 `trustedHosts = [...lanAddresses, ...extra]`，其中 `lanAddresses` 仅在
  `bindHost === "0.0.0.0"` 时采样本机非 internal IPv4 字面量，否则为空数组。
- 装配进围栏：`@deepseek-ai/dsh-web-app/cordis.patch.yml:185-188`
  —— connection 行的 `trustedHosts: !!js ctx.webRuntime.trustedHosts`。

即：**该 flag 只影响「哪些 Host 头被接受」，不影响监听地址、不影响认证**。
（本节均为源码判读，无实测项。）

### 2.2 围栏判定链

`@deepseek-ai/dsh-client-connection/lib/index.js:198-212` `isTrustedApiRequest()`：

1. 无 `Host` 头 → 拒；`Host` 无法解析 → 拒；
2. Host 既非 loopback 又不命中 `trustedHosts` → **403**；
3. `sec-fetch-site: cross-site` → **403**；
4. 带 `Origin` 时必须 `Origin.host === Host.host`，否则 **403**；
5. 通过围栏但未认证 → **401**。

条目语法（`assertTrustedAuthority` / `isTrustedAuthority`，同文件 `:152-196`）：
带端口条目精确匹配 authority，**不带端口条目匹配该主机名的任意端口**；畸形条目
（多余路径、`user@host`、悬空冒号、零填充端口、非规范主机拼写）会让插件加载直接失败，
不静默放宽。

**关键边界**：该围栏的文档明确写明这类检查「绝不建立身份」，并给出状态码分层
「Host/Origin 校验失败返回 403；Host 可信但未认证的请求返回 401」
（`@deepseek-ai/dsh-client-connection/README.zh.md:39`，同一行还确认 `dsh web --host 0.0.0.0`
仍不受支持）。身份来自 token 换 cookie（`lib/index.js:370-381` `authenticatedUrl()`、
`:391-405` 根路由换 cookie），`/api` 每个方法与 WebSocket 流都另行认证。

### 2.3 bind 侧约束

- 命令行硬拦（**实测**，`dsh --profile web --host 0.0.0.0 --no-open`）：

  ```
  error: --host 0.0.0.0 is intentionally not supported yet for safety: it would expose
  remote code execution to the network; use 127.0.0.1 instead
  ```

  拦截点：`@deepseek-ai/dsh-web-app/lib/startup.js:40`。
- schema 只接受两个字面量：`@deepseek-ai/dsh-host-webserver/lib/index.js:141`
  —— `host: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required()`。
  因此**不能**通过绑具体局域网 IP 来绕过（既非 CLI 拦截面，也不在 schema 允许集内）。
- 于是「官方方案上局域网」唯一通路是在 profile 的 `cordis.patch.yml` 里按 id 覆盖
  `webserver` 行。注意该 patch 语义为**整块替换 config**（见
  `@deepseek-ai/dsh-web-app/cordis.patch.yml:5`「A patch replaces the targeted
  row's whole `config`」），`compression` 等同层键必须一并重述；且 `host` 只能写死字面量，
  照抄 `!!js ctx.webStartup.host` 表达式会让 CLI 的 `--host` 继续压过配置。

---

## 三、实测记录

隔离环境：`DSH_HOME=$(mktemp -d)`，`dsh --profile web --host 127.0.0.1 --port 3099
--no-open --trusted-host gui.lan`。所有请求经 curl 直打 3099，用 `-H "Host: …"` 模拟
不同 authority。

### 3.1 `/api` 围栏矩阵（围栏所在层）

| 请求 Host | 附加头 | 状态码 | 含义 |
|---|---|---|---|
| `127.0.0.1:3099` | — | 401 | loopback 放行，未认证 |
| `gui.lan` | — | 401 | 命中 `--trusted-host`，放行 |
| `gui.lan:3099` | — | 401 | 不带端口条目匹配任意端口 |
| `evil.example.com` | — | **403** | 未受信 authority |
| `192.168.1.50` | — | **403** | IP 字面量但未声明（Bind 为回环，未派生 LAN 字面量） |
| `gui.lan` | `sec-fetch-site: cross-site` | **403** | 跨站拒绝 |
| `gui.lan` | `Origin: http://evil.example.com` | **403** | Origin 与 Host 不同源 |
| `gui.lan` | `Origin: http://gui.lan` | 401 | 同源，放行 |

这张矩阵是本次评估最直接的证据：403 → 401 的差别说明 `--trusted-host` 确实在生效，
但**生效的范围仅限「准不准进门」**。

### 3.2 认证后的可达范围

| 步骤 | 结果 |
|---|---|
| `GET /?token=<launch token>`（Host `gui.lan`） | **303**，`Set-Cookie: dsh-auth-<hash>=…; HttpOnly; SameSite=Strict` |
| 带该 cookie `GET /` | **200** |
| 带该 cookie `GET /api` | 404（路由面未命中，非围栏/认证问题） |
| 带该 cookie 但 Host 换回 `evil.example.com` | **403**（围栏先于认证） |

补充（源码判读）：`@deepseek-ai/dsh-client-connection/lib/index.js:252-281` 把
**authority 写进 cookie 名（sha256）与签名载荷**，`Set-Cookie` 载荷中的 `authority`
字段即当前 Host。实测中 `authority` 为 `gui.lan`，印证 cookie 与访问地址绑定——
换地址访问会失去 cookie 并回到 401，需重走 token。

另注：`GET /` 不经过 `isTrustedApiRequest`（围栏只挂在 `/api`），因此非受信 Host 的
根请求返回 401 而非 403；这不影响上述结论。

### 3.3 「改模型/改设置」是否受限

- **host 端全量搜索无据可依的限制**：`grep -rn "remoteAddress" node_modules/@deepseek-ai/*/lib/*.js`
  **零命中**；`@deepseek-ai/dsh-api-gateway` 的 RPC 分发（`lib/index.js:455` intercept、
  `:566` `dispatchRpc`、`:510` `claimsEndpoint`）未见按来源 IP 或 loopback 的准入分支。
  （源码判读）
- 改模型与改设置走的就是 `/api` RPC 通道（`endpointFromPath`：`/api/<endpoint>`，
  `@deepseek-ai/dsh-client-connection/lib/index.js:673-678`），即 3.1/3.2 已验证放行的
  同一条通道。因此**认证后即为完整会话权限**：可改模型、可改设置，也可执行 shell、
  读写宿主文件——这正是 2.3 那句警告所指的 "remote code execution to the network"。

---

## 四、与 lan-proxy 的逐维度对比

本插件侧引用为仓库源码行号（`packages/dsh-lan-proxy/src/proxy.ts`）：

| 维度 | 官方 `--trusted-host`（+ 强开 `0.0.0.0`） | lan-proxy |
|---|---|---|
| 达成 LAN 可达 | 声明式白名单；需 profile patch 强开 `0.0.0.0` | 反代 + Host/Origin 重写（`proxy.ts:298-303` `rewriteHeaders`） |
| dsh 本体监听面 | **全网卡暴露**（本体直接面对网络） | 保持回环，暴露面在代理层 |
| 信任粒度 | `host` 或 `host:port`，可放域名 | 只接受 IP 字面量与 `localhost`（`proxy.ts:276-288` `hostnameAllowed`），域名一律 403 |
| 端口面 | 不带端口条目 → 该主机名任意端口可信 | 入站端口独立（HTTP 3081 / HTTPS 3443，`proxy.ts:417`） |
| 认证 | 保留 token/cookie（403/401 分层） | 保留上游认证，另加 `injectToken` 帮 LAN 设备自动铸 cookie |
| HTTPS / TLS | 无 | 并存（自签或自定义证书，`src/cert.ts`） |
| HTTP 响应压缩 | **自带 gzip**（`@deepseek-ai/dsh-host-webserver/lib/index.js:104-124`，bundle 里 `compression: gzip`）；不产出 Brotli | Brotli/gzip 自适应协商 + 档位控制；但在上游 gzip 生效时被遮蔽，见 4.1 |
| WS 帧压缩 | 无 | permessage-deflate 桥接（`permessage-deflate` 仅浏览器段） |
| WebSocket 保活 | 无 | Pong 代答 + 半开探活（移动端切后台不断连） |
| 对 dsh 的改动 | 需改 profile patch | 插件挂载，dsh 本体零改动 |
| 上游围栏交互 | 本体即围栏持有者 | 上游永远看到回环 authority，天然通过 |

**重叠面的准确定位**：「让局域网设备通过 Host 围栏」这一件事，官方给出了等价能力
（且是本文档所述的 `--trusted-host` 存在的理由）；本插件在同类目标上用的是另一套
机制。其余各行都不重叠。

本插件源码注释（`src/proxy.ts:15-21`）中「LAN 转发器无法向该围栏追加受信项（它只从
配置解析一次）」的判断在此复核为**准确**：`trustedHosts` 是启动时按配置解析一次的数组，
插件无法在运行期追加；可行的官方通路是引导用户改 profile patch，属配置层动作，
不是插件能替用户完成的事。

### 4.1 复核中发现的偏差：HTTP 响应压缩的实际归属

核实「官方是否有压缩」时发现一处与 README 表述的偏差，记在此处。

**事实链**（第 1、3 条为源码判读，第 2 条为实测，第 4 条是基于前三者的推断）：

1. 官方 webserver 自带 gzip：`@deepseek-ai/dsh-host-webserver/lib/index.js:104-124`
   `createGzipMiddleware` 用 `compression` 库，`onHeaders` 前置把请求头的
   `accept-encoding` 改写为 `Negotiator` 的 `encoding(["gzip", "identity"])` 结果——
   **只可能产出 gzip，永不产出 Brotli**；其 config schema（同文件 `:143-145`）只允许
   `compression: none | gzip`，而 `@deepseek-ai/dsh-web-app/cordis.patch.yml:141-143`
   把 web 组合显式设为 `compression: gzip`。
2. 实测（隔离实例 + 用户实例一致）：客户端声明 `Accept-Encoding: br, gzip`，直连官方
   web 服务器得到的仍是 `Content-Encoding: gzip`。
3. `compression` 库在 `onHeaders` 里对已编码响应直接放弃（
   `@deepseek-ai/dsh/node_modules/compression/index.js:183-188`：
   `encoding !== 'identity'` → `nocompress('already encoded')`）。
4. 结论：官方 gzip 生效的响应，本插件的压缩中间件（`src/proxy.ts:704-718`，Brotli
   档位由 `resolveCompressionOptions`（同文件 `:247` 起）映射）拿到的
   `Content-Encoding` 已是 `gzip`，按其自身语义让位（`src/proxy.ts:116` 注释所称的
   「经 content-encoding 检查天然互斥」）。**若仅凭以上推理，会得出「Brotli 一律不生效」
   的绝对结论——下面的实测把条件收窄了。**

**端到端对照实验（实测，2026-09-10）**：上游用等价中间件复现官方 gzip 逻辑
（同 `:104-124` 的 `Negotiator(["gzip","identity"])` + 同库同阈值），转发层用真实
`createLanProxy`（`lib/index.js` 构建产物，`httpCompress: { enabled: true, level: 1 }`），
同一份未压缩 322900 字节的 JSON：

| 客户端声明 `Accept-Encoding` | 直连上游（CE / 字节） | 经 lan-proxy（CE / 字节） |
|---|---|---|
| `br, gzip` | gzip / 10948 | gzip / 10948（未重压） |
| `gzip` | gzip / 10948 | gzip / 10948（未重压） |
| `br`（仅声明 br） | identity / 322900 | **br / 5065** |
| 未声明 | identity / 322900 | identity / 322900 |

（CE = `Content-Encoding`；lan-proxy 协商计数 `{compressed: 4, passthrough: 0}`。）

复核结论：上一条推理只在「客户端同时接受 gzip」时成立。**Brotli 并非完全被遮蔽，
而是被严格限制在「上游未压缩 + 客户端只声明 br」这一条件**——主流浏览器都发
`br, gzip`，因此实际部署中拿不到 Brotli 收益；一旦命中条件，Brotli 仍显著优于不压缩。
本次评估的初版结论过强，已按实测修正。

**对本插件的影响**：README 原表述「客户端 Accept-Encoding 含 br 时优先 Brotli」在
主流浏览器场景下不成立。这不是正确性缺陷（只压一次，无双重压缩，`AGENTS.md` 的
「不双重压缩」约束依然满足），属功能声明与实际行为不一致。

**处置（本 PR 范围）**：按实测修正 `README.md` 的相关表述（「HTTP 响应压缩」节新增
生效条件表、配置表两处措辞、`httpCompressEnabled: false` 的效果说明），保留 Brotli
能力声明与其价值，但去掉「br 优先」这一会造成误解的表述。

**未处置（留待另议）**：是否让 Brotli 在主流浏览器下也真正生效（需对上游 gzip 响应
解压后以 br 重压，代价是 CPU 与流式语义复杂化），取决于产品意图，不在本次授权范围。

---

## 五、二者同开时的相互影响

若用户既配了 `--trusted-host`（或强开 `0.0.0.0`）又启用本插件：

1. 经代理的请求，上游永远只看到重写后的回环 authority，**上游 `trustedHosts` 形同虚设**；
   实际把关的是本插件的 `hostnameAllowed`。
2. 直连回环（不经代理）的请求仍按官方围栏与认证处理。两条路径的信任判定不同源，
   但都以 dsh 的 token/cookie 作为身份层，因此不产生越权，只是**判定面不一致**，
   排障时容易误判（"我明明配了 `--trusted-host` 为什么还是 403" —— 因为请求走的是代理）。
3. `sec-fetch-site` 由本插件原样透传（`src/proxy.ts:28-30`），跨站页面仍被上游拒绝，
   防御链完整，不因重写 Host 而放松。

---

## 六、不做薄化的判定依据

按权重排序：

1. **官方缺的不是白名单，是开口**。`--trusted-host` 已就位，但 `--host 0.0.0.0` 仍被
   以安全理由硬拦（实测）。要用官方方案覆盖同场景，必须用配置层绕过这道拦截，
   代价是 dsh 本体暴露在网络、防线收窄为 token/cookie，同时**仍然拿不到** HTTPS、
   压缩与 WS 保活。这不是「用官方换掉自研」，而是「既变薄又变差」。
2. **本插件的主体价值不在 Host 信任那一层**。HTTPS/证书、WS 桥接保活、WS 帧压缩
   都属代理层能力，官方当前无对应实现；HTTP 响应压缩虽是官方已有的 gzip，但本插件
   在这条链路上也拿不到 Brotli 的实际收益（4.1）。即便把 Host 信任整层交还官方，
   插件仍需保留代理层，复杂度不会下降。
3. **重叠层的语义替换有净风险**。官方是「声明才放行」，本插件是「重写为回环 +
   自守 IP 字面量」；两者都已通过各自测试（本包围栏用例见 `test/smoke.ts:404`
   「DNS-name Host refused with 403」、`:410` HTTP/1.0 无 Host 拒绝）。为消除重复而
   更换一层已验证的安全语义，收益是概念上的整洁，成本是重新验证与回归风险。

---

## 七、重新评估触发条件

出现以下任一情况时，应重新发起本评估（建议挂在 dsh 升级评估的检查项里）：

1. dsh 放开 `--host 0.0.0.0`（或提供受支持的 LAN 直连配置面），且
2. 同时至少满足其一：
   - 官方 webserver 提供 TLS（含自签/证书配置）；
   - 官方提供与压缩相关的传输增强（HTTP 响应压缩或 WS permessage-deflate）；
   - 官方在 API/WS 层提供保活（Pong 代答或等价的心跳策略）。

满足后需重新判断的**具体问题**：可达性与传输增强能否整体交还官方，本插件是否退化为
只保留「域名入站 + IP 字面量围栏」这类差异化能力。

### 本次评估未覆盖、下次需补的验证项

- **smoke 未覆盖 br 分支**：`test/smoke.ts:808-834` 的压缩用例全部只发
  `accept-encoding: gzip`，没有任何断言走到 br 路径——这正是「br 优先」这一失实描述
  能长期存活的原因。建议后续补一条 br 用例锁定 4.1 的实测语义。
- 强开 `0.0.0.0` 后 `resolveLanTrust` 的 LAN 字面量派生与打印 URL（LAN: 前缀）在真实
  双机环境下的表现——本次仅在单机隔离实例验证到围栏矩阵，未跨机实测。
- cookie 的 `SameSite=Strict` 在真实局域网入口（`http://<LAN-IP>:<port>`）下换 cookie
  与后续 WebSocket 升级的完整成功路径。
- 官方方案下模型设置页与凭据类设置的写入是否触发额外确认（当前无代码证据表明存在，
  但也未逐项实测）。
