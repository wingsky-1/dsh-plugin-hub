# 安全政策（Security Policy）

本文件是 dsh-plugin-hub 的安全漏洞报告政策：哪些版本受理、私密报告走哪里、
响应时限如何约定、哪些属于设计而非漏洞。日常缺陷与功能建议请走普通 issue，
不要把未修复漏洞的细节写进公开 issue 或 discussion。

## 支持的版本（Supported Versions）

> 本文件描述**本分支/下一适配版本**的 rc.1 基线；npm 已发布的 `0.2.10` 仍属于旧 rc.2 基线。源码版本号保持 `0.2.10`，正式发布号另行确定。

本插件集下一适配版本面向 DeepSeek Harness `0.2.2-rc.1`（Cordis `4.1.0`）。适配基线的权威版本事实源是
`pnpm-workspace.yaml` 的 catalog；各包 peerDependencies 是由维护流程生成的精确版本投影；
catalog 更新前，不承诺 alpha、旧 runtime 或其他 DSH 版本的兼容与安全修复。

- 当前基线：即上条所述 catalog 锁版（版本号不在本文件复述，以免与事实源漂移）。
- 受理：在 catalog 锁定的当前基线上可复现的安全问题。
- 不受理：alpha、旧 runtime 或其他未锁定版本环境下复现的问题；已在 README 声明退役、
  不再维护的包的问题（此类问题请先卸载对应包，仍有疑问走普通 issue 讨论）。

| 版本线 | 是否受理 |
| --- | --- |
| 当前基线（catalog 锁版，见上）上的最新发布包 | 受理 |
| 旧版本包（已有新版修复） | 请先升级到最新版再验证，不单独修旧版 |
| dsh alpha、旧 runtime 或其他未锁定版本 | 不受理 |
| 已退役、不再维护的包 | 不受理 |

## 漏洞报告（Reporting）

- 请勿开公开 issue 披露未修复漏洞的细节（复现步骤、利用链、受影响部署信息）。
  需要公开讨论时，先走私密通道，待修复发布后再按协调结果公开。
- 报告通道：本仓库 GitHub 页面 Security 选项卡下的 Report a vulnerability
 （Private vulnerability reporting 私密通道）。
- 报告请尽量包含：受影响包名与版本、dsh 本体版本（rc 号）、复现步骤、
  影响评估（能读到什么、能做到什么、需要什么前置条件）、已知的缓解手段。
- 请不要在报告里附带真实凭据、真实用户数据与可直接利用的武器化代码；
  必须附带敏感材料时请在私密通道内说明获取方式。

## 原生 LAN 与 TLS 边界（Native LAN and TLS）

DSH 原生 LAN 入口允许显式绑定一个具体的本机 IPv4/IPv6 地址。`--public-url` 只对外公布
HTTP(S) 根地址，不授予请求信任；`--trusted-host` 只扩展接受的 Host/Origin authority。
原生 TLS 由使用者提供的完整 PEM 证书链与未加密 PEM 私钥启用，客户端必须信任对应 CA，
证书 SAN 必须覆盖实际访问 authority。TLS 不提供调用者认证，不会自动管理本地 CA、
证书续期、ACME 或替客户端分发信任材料。

插件原始 HTTP API 保留 loopback 快路径；非回环短请求只有在官方
`ctx.connection.requestRejection(req)` 返回 `undefined` 时才可准入。该官方验证面覆盖
Host/Origin、跨站、cookie 与 API peer；缺失、抛错或返回 401/403 均须 fail-closed。
非回环 SSE 等长流还必须经 `ctx.connection.admit` 保留 admitted `PeerScope`，并将关闭
绑定到 Peer 生命周期；释放后必须停止广播、从连接表移除并关闭响应。逐插件安全适配与
隔离验证仍在进行，不能把当前设计当成已完成兼容承诺。不得把 LAN 地址、TLS 成功或可
伪造的 forwarded-address 头当作认证信号，也不得删除既有 401/403/405 反例。

本仓不承诺“卸载 `dsh-lan-proxy` 后所有插件在 native LAN 下均可用”。部署者必须按插件
分别验证 HTTP API、SSE/WebSocket、Host/Origin、token/cookie 与无凭据、错 Host、跨站、
错方法反例。迁移说明见 [lan-proxy 退役迁移](docs/migrations/dsh-lan-proxy.md)。

## 响应预期（Response Expectations）

以下为上限承诺，具体以私密通道内的实际回复为准：

- 确认收悉：收到报告后 1 个工作日内在私密通道内确认。
- 评估结论：确认后 3 天内给出是否构成漏洞、严重程度与修复计划。
- 修复发布：确认的高危及以上问题 5 天内发布修复版本或可用的缓解措施；
  低危问题随常规版本修复。
- 负责任披露：在修复版本发布前，请报告者不要公开细节；修复发布后，
  维护者会在 Release Notes 中说明，报告者可按约定时点公开。
- 若上述时限因故无法兑现，维护者会在私密通道内说明原因并给出新的时间表。

## 范围（Scope / Out of Scope）

受理范围：本仓当前发布的插件自身代码（`packages/dsh-*/src`、`shared/` 共享模块、
随包发布的配置与文档）中可复现的安全缺陷。

以下不视为漏洞（Out of Scope）：

- `dsh-lan-proxy` 已停止独立维护并退出当前源码树与聚合包。其历史默认值、实现缺陷与
  迁移中接受的 WebSocket 保活/压缩、CA 管理或自动 token 注入能力差异，不再进入当前
  基线的常规修复范围；已安装旧版本的问题请先按迁移说明卸载。native LAN 的认证拒绝、
  Peer admission 失败或长流生命周期绑定失败仍是 fail-closed 结果，不是绕过认证或
  “LAN 已全面可用”的证据。
- 用户自行管理的 native TLS 证书是否存在、是否过期、SAN 是否覆盖访问地址，以及客户端
  是否正确信任 CA，属于部署责任；证书私钥泄露不属于本仓插件代码漏洞。
- 凭据存放：本仓约定凭据只以环境变量引用的方式提供，不在仓库、配置示例与文档中
  出现明文凭据；因把示例占位凭据当作真实凭据使用、或自行把明文凭据写入配置与日志
  而导致的问题不按漏洞受理。
- 第三方依赖漏洞：DSH 本体、npm 上游包等第三方组件的漏洞请先报告上游，
  本仓在上游修复后跟随升级，不在本仓单独修上游代码。
- 非本仓可控面：用户自改代码、社会工程、物理接触设备、用户主机已被攻陷后的连带影响。

本仓暂无漏洞赏金计划，感谢每一位负责任披露的研究者，修复发布时会在
Release Notes 中致谢（报告者可选择匿名）。
