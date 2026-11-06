# dsh-lan-proxy 退役迁移

状态：`@wingsky-1/dsh-lan-proxy` 已停止独立维护，并从当前源码树与
`@wingsky-1/dsh-plugins-all` 聚合包移除。已发布的 npm 版本仍可被显式安装，但不会获得
后续 DSH rc 适配。退役范围与讨论见
[#1159](https://github.com/wingsky-1/dsh-plugin-hub/issues/1159)。

本页面向已安装旧包的部署者。当前适配基线是 DSH `0.2.2-rc.1` 与 Cordis
`4.1.0`。本页依据官方 npm 包的类型与 CLI 声明、上游实现和本仓源码；
未列入兼容承诺的 native LAN 组合不能仅凭文档视为已验证。

## 先确认这不是等价替换

DSH 原生入口覆盖了“绑定 LAN 地址、提供 HTTPS、按 HTTP 协商 gzip”这几项入口能力，
但旧包与原生入口的认证边界、证书生命周期、压缩范围、WebSocket 行为和安全围栏不同。
卸载旧包不保证插件在新的 LAN 入口下全部可用。

插件 HTTP API 的目标安全模型保留 loopback 快路径；非回环短请求只有在官方
`ctx.connection.requestRejection(req)` 返回 `undefined` 时才可准入。该验证覆盖
Host/Origin、跨站、cookie 与 API peer；验证缺失、抛错或返回 401/403 时必须 fail-closed。
非回环 SSE 等长流还必须经官方 `ctx.connection.admit` 取得并保留 admitted `PeerScope`，
把关闭绑定到 Peer 生命周期；Peer 释放后必须从广播/连接表移除并关闭流，不能继续向已
释放的 peer 推送。新部署应在目标环境逐插件完成认证与长连接验收，再对外提供 native LAN
服务。TLS 成功、LAN 地址或客户端自报的 forwarded-address 头都不能替代调用者认证。

## 官方能力的证据边界

以下事实由 DSH `0.2.2-rc.1` 官方 npm 树的 CLI 声明、类型和所检查实现，以及本仓源码核对：

- `--host` 只接受一个具体的本机 IPv4/IPv6 地址，不接受 wildcard 全网卡绑定；
- `--public-url` 只公布对外 HTTP(S) 根地址，不授予请求信任；
- `--trusted-host` 扩展 Host/Origin 接受的 authority，不等于开放监听或完成用户认证；
- `--tls-cert` 与 `--tls-key` 必须成对提供；证书文件使用完整 PEM 链，私钥文件使用未加密
  PEM；TLS 启动失败不会回退到 HTTP；
- 官方入口不提供 ACME、自签证书回退、证书监听/热更新、本地 CA 管理、移动端 CA 分发或
  自动续期；
- Host 围栏接受 loopback、监听地址字面量和配置的 trusted host；Origin 必须与 authority
  同源，跨站请求拒绝；Host/Origin 失败通常为 403，通过 authority 围栏但没有有效认证时
  为 401；
- API 与 WebSocket 都必须完成启动令牌交换或携带有效的签名会话 cookie；TLS listener
  签发的会话 cookie 带 `Secure`。短请求身份校验与长流 Peer 生命周期是两层要求，
  单次 `requestRejection` 成功不能代替 admitted PeerScope 的绑定与释放；
- 官方 HTTP 压缩选项是 `none | gzip`，不提供 Brotli；
- 本仓隔离验收中，native remote mux 已实际协商 `permessage-deflate`；官方 WebSocket
  路径还会发送 Ping 并终止不活跃连接。这只能说明协议协商与官方路径行为存在，不等于旧包
  按插件路径配置的压缩桥接、半开保活策略和移动端重连表现可等价替换。

以上是长期能力与边界。部署者在开放 LAN 前必须完成真实 TLS、证书信任、token/cookie、
SSE/WebSocket、移动端后台重连和各插件 API 的逐项验收。

## 主要差异

| 维度 | 旧 `dsh-lan-proxy` | DSH `0.2.2-rc.1` 原生入口 |
| --- | --- | --- |
| 监听与转发 | DSH 保持回环，插件代理层对 LAN 暴露并以回环上游转发 | DSH 直接绑定一个具体 LAN 地址，没有插件代理层 |
| 地址与 authority | 代理层改写 Host/Origin 后访问回环上游 | 原生 Host/Origin 围栏直接处理 LAN authority |
| 认证 | 历史 `injectToken` 可为符合条件的请求自动铸会话 | 只接受官方启动令牌交换与签名会话认证 |
| 插件 API 围栏 | 回环上游让部分插件看起来来自 loopback | loopback 走快路径；非回环短请求须通过官方 `requestRejection`，长流还须经 `admit` 并绑定 Peer 生命周期，否则 fail-closed |
| TLS 证书 | 自签或自定义证书，旧包提供对应管理面 | 用户提供完整证书链与未加密 PEM 私钥 |
| CA 生命周期 | 旧包曾提供本地 CA、状态与证书下载面 | 没有本地 CA 管理或客户端分发；由部署者管理 |
| HTTP 压缩 | Brotli/gzip 自适应协商 | `none | gzip` |
| WebSocket | 插件侧路径白名单、压缩桥接和半开保活策略 | native remote mux 已协商 `permessage-deflate`，并有 Ping/不活跃终止；旧包逐路径策略不承诺等价，须逐项记录 |
| 域名访问 | 由代理规则处理，入站目标以 IP 字面量为主 | 域名 authority 必须显式进入信任配置，并满足同源与认证 |
| 诊断面 | 旧插件 health、CA 与配置路由 | 随包注销；使用官方启动输出与宿主诊断，不复用旧路由 |

## 迁移步骤

1. 升级前备份插件配置、会话数据和旧包管理的证书材料。私钥与恢复包不得进入仓库、日志、
   issue 或 PR；备份完成前不要删除旧数据。
2. 先把 DSH 升级到仓库当前锁定的 `0.2.2-rc.1`，确认 `dsh --version`。插件包要使用与
   该基线精确匹配的发布版本；不要用绕过 peer 校验的选项混装其他 DSH 版本。
3. 查看已安装插件。独立安装旧包时移除它；来自聚合包时，更新到已移除该成员的新聚合版本。

   ```sh
   dsh plugin --profile web list
   dsh plugin --profile web remove @wingsky-1/dsh-lan-proxy
   dsh plugin --profile web update @wingsky-1/dsh-plugins-all
   ```

   只有包含退役变更的聚合版本才会拉齐四个成员。更新前仍会保留旧成员，不能把普通更新
   当成已生效的退役。

4. 如确实需要 native LAN，按官方 CLI 选择**一个具体本机地址**，成对提供证书链与私钥，
   并为实际访问的 authority 配置信任。以下只展示形态，尖括号内容必须替换成可访问的
   通用配置；不要把这些值通过公开日志或仓库传播：

   ```sh
   dsh web \
     --host <concrete-local-ip> \
     --tls-cert <full-chain.pem> \
     --tls-key <unencrypted-private-key.pem> \
     --trusted-host <visited-authority> \
     --public-url https://<visited-authority>
   ```

   `--public-url` 不会扩大信任范围，wildcard 地址也不是受支持的回退方案。证书 SAN 必须
   覆盖访问 authority，客户端必须预先信任签发 CA。不要提交、粘贴或记录私钥和令牌。

5. 重启 `dsh web` 和浏览器。用独立浏览器上下文完成启动令牌交换，确认签名会话生效；
   再按插件分别验证 API、SSE/WebSocket、Host/Origin 与无凭据拒绝。
6. 在迁移完成、配置和无凭据访问均核对后，再按组织的数据保留策略处理旧 settings
   namespace、插件私有配置与证书/CA 目录。源码退役不会自动删除这些磁盘数据，也不会
   自动清理同一个旧插件写入的私有材料。

## 逐插件验收矩阵

下列项目是迁移的完成条件。没有真实结果的项必须标为 `NOT-RUN`，不能用“官方支持 TLS”
或 loopback 本地测试代替。

| 检查 | 要求 |
| --- | --- |
| 版本与装载 | DSH、聚合/独立插件版本精确匹配；重启后四个功能包按预期装载 |
| TLS 信任 | 证书链、私钥、SAN、客户端 CA 信任与 `Secure` cookie 行为逐项通过 |
| Host/Origin | 正确 authority 可进入认证；错 Host、跨站和缺失 token 分别保持拒绝 |
| 插件 HTTP API | `mcp-manager`、`notifier`、`provider-usage` 各自的关键读取与写入路径有独立结果，含官方接缝的 401/403/undefined 三分支 |
| 长连接生命周期 | 非回环 SSE 成功绑定 admitted PeerScope；Peer 释放后停止广播、移出连接表并关闭流，断线或异常路径不留下可写连接 |
| SSE/WebSocket | 长连接建立、认证、压缩协商、Ping/重连和后台恢复逐插件记录，并用至少一台真实移动设备完成验证 |
| 既有反例 | 普通 loopback 403/405 反例和 native LAN 无认证 401 均保持 |
| 数据与证书 | 旧 settings、配置和证书材料有备份；私钥不进入仓库、日志或公开报告 |

## 保留与回滚

- 旧 settings namespace、插件配置和证书/CA 材料默认保留。是否删除由部署者在备份、
  私钥暴露面核对和业务需求确认后单独决定。
- npm 已发布旧版本仍可显式安装，但它不再跟随当前 DSH rc。回滚时必须同时恢复与该旧插件
  匹配的 DSH 版本和 profile 声明，不能只把插件加回新宿主。
- 回滚后重新执行版本、插件装载、HTTP/WS、Host/Origin、证书信任与无凭据拒绝检查。
  回滚不是自动动作，也不会由本仓的退役改动代执行。

## 历史证据

退役前保留的
[官方 LAN 访问能力重叠评估](../architecture/dsh-lan-proxy-official-access-assessment.md)
记录了旧基线下的决策依据。它属于历史材料，不描述当前 `0.2.2-rc.1` 能力，也不构成
native LAN 兼容或安全承诺；当前迁移边界以本页和实际隔离验证为准。
