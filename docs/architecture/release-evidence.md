# 发布证据束规格（3.7 S1：release-evidence.json 模式与判定表）

> 本片性质：纯规格片。把发布证据束的字段定义、载体口径与合格判定写成文档，
> 不新增采集脚本、不改 release.yml、不改门禁语义、不碰公共 API，本片零源码改动。
>
> 前置结论（主控已亲验，本规格直接采用）：3.7 E1-E8 与 G1-G8 已验收；
> S2 实施已合入 #902；R3-ex 已随 #902 关闭。本片不重述上述验收过程，只落字段与判定。
>
> 证据基线：本分支基点 origin/main 7b8eb997。行号会随提交漂移，下文引用一律以符号名
> （文件名、字段名、步骤名、W 编号、G 编号）为准，可用符号搜索复核；行号只在注明处作基线快照。
>
> S2 实现（#902，提交 01697200）不在本分支祖先链内（已用 merge-base 核验），
> 凡涉 S2 新增符号一律以该提交的代码为准，不以本分支树为准；本分支基线未含的文件
> 只作符号名引用，不作相对链接（相对链接须指向现存文件，见第 10 节）。
>
> 语义分歧以门禁代码与源码为准，本文档只是规格记录。
>
> 快速上手见各包 README；门禁分层与归属见 [docs/GATE.md](../GATE.md)；
> 架构总览见同目录 [README.md](README.md)。本文只记录发布证据束的模式与判定，
> 不重复采集实现与包内配置的内容（配置面见 [pkg-config-behavior.md](pkg-config-behavior.md)）。

## 1. 定位与范围

- S1 = release-evidence.json 的模式与判定表（本片）；S2 = 采集与上传实现（#902，
  已合入，不属本片；对应关系见第 8 节）。
- E1-E8 是 8 个证据项，每项的定义 = 输出摘录 + 附件 sha256（见第 3 节）；
  8 项的排序即 release.yml 执行序（observe job 在先，publish 链按步骤序）。
- G1-G8 是 3.7 门禁验收项（主控已验收，本片不展开验收细节；其中 G5 的代码位置见第 8 节）。
- 本片判据只覆盖证据齐备性判定（缺任一条即不合格，见第 5 节）；
  发布链路既有判据（版本一致、全量门禁、聚合一致等）的内容 verdict 归各自代码，本片不替代。
- 载体口径见第 4 节：Release 附件首选，CI artifact 备选。

## 2. release-evidence.json 模式

清单文件的字段模式（本模式尚无装配实现，装配本体另立项，不属本片）：

- schemaVersion：固定为 "1"。
- tag：vX.Y.Z 形态，版本唯一来源口径与版本门禁一致（tag 即来源，不另设版本字段）。
- producedAt：装配时刻，ISO 时间。
- carrier：取 "release-assets" 或 "ci-artifact"（见第 4 节），声明本次清单随附的载体。
- items：E1-E8 数组，每项含 id（E1 至 E8）、file（附件文件名）、excerpt（输出摘录）、
  sha256（该附件文件的 SHA-256，hex 小写）。
- verdict：取 "qualified" 或 "unqualified"，由第 5 节判定表得出；8 行全合格才为 qualified。

excerpt 的形态按附件种类固定：日志类取判据行原文摘录，JSON 类取判定输入或状态原文，
SHA256SUMS 类取校验和行原文（各 E 项的具体形态见第 3 节）。sha256 一律指对附件文件
本身取哈希（E7 的附件即 SHA256SUMS 文件本身，对它再哈希，不递归）。

## 3. E1-E8 字段定义（输出摘录 + 附件 sha256）

| ID | 附件文件 | 输出摘录 | S2 生产者 |
| --- | --- | --- | --- |
| E1 | observe-runs.json | 取到的 runs 数组原样（与离线复跑输入同形） | W1.5：observe-precheck.mjs 的 --runs-out |
| E2 | observe-inputs.json | 本次判定的输入面五键：workflow、maxAgeHours、perPage、now、overridden | W1.5：observe-precheck.mjs 的 --inputs-out |
| E3 | verify-version.log | 逐包 OK 与 FAIL 行加汇总行（标准输出与标准错误逐行镜像） | W1.1：verify-version.ts 的 --log-file |
| E4 | pack-check.log | 标准输出判据行镜像 | W1.2：pack-check.ts 的 --log-file |
| E5 | verify-npm-layout.log | 标准输出判据行镜像 | W1.2：verify-npm-layout.ts 的 --log-file |
| E6 | baseline-staleness.json | 基线状态（含 status 三态 fresh、stale、unknown，加龄、基线提交 SHA、工单标题） | W1.4：baseline-staleness.mjs 的 --warn-only 加 --status-file |
| E7 | SHA256SUMS | 校验和行（sha256sum 文本形态：hex 加两空格加 tgz 文件名） | W1.3：collect-tgz-evidence.mjs 的 renderShaLines |
| E8 | collect-tgz-evidence.log | 收集日志（待发布包清单行、pack 行、SHA 行、tgz 本体删除声明） | W1.3：collect-tgz-evidence.mjs |

分项口径（均为 S1 对 S2 语义的转述，分歧以第 8 节所指代码为准）：

- E1：判红路径同样落盘（红 run 的证据最有价值）；落盘失败即 fail-closed
  （证据写不下来等于没有证据，不静默放行）。
- E2：override 形态只写 inputs（无数据不伪造空 runs）；环境变量开关只认字面量 true。
- E3：父目录逐级建出；落盘失败 fail-closed（exit 1）；含非 tag 环境与空包集的 fail 行形态。
- E4 与 E5：落盘面只镜像判据行，不改变判据本身；落盘失败同样 fail-closed。
- E6：发布链路以 --warn-only 调用，stale 与 unknown 只打 warning 注解，退出码恒 0；
  阻断语义仍归 observe 前置（E1 与 E2 面），基线龄自身在发布链路不判红。
- E7 与 E8：包集合与发布步骤同源（子进程复用待发布清单，清单取不到即判据失败）；
  待发布包集合为空禁止全绿；tgz 本体在生成校验和后删除，只上传校验和与日志，不传本体；
  证据目录只用 RUNNER_TEMP 下路径（workspace 零落盘的结构保证）。

## 4. 载体：Release 附件首选，CI artifact 备选

- 首选载体为 GitHub Release 附件：release-evidence.json 本体加 E1-E8 附件随对应
  tag 的 Release 附上；发布即存证，不受 CI artifact 留存期限制。
- 备选载体为 CI artifact，即 S2 现状的两处上传：release-evidence-observe-precheck
  （runs 快照加判定输入）与 release-evidence-publish（版本与产物日志加校验和加基线状态）；
  上传 pin ea165f8d，retention 14 天，if-no-files-found warn；
  仅绿盘存证，红盘看判据日志（失败时上传步骤被跳过，不加 always）。
- 规则：备选链路缺失不降级首选结论；verdict 只认 E1-E8 本体齐备（第 5 节），
  不认 artifact 条目存在；S2 现状只打通备选链路，首选链路的装配与挂载另立项。

## 5. 判定表（缺任一条即不合格）

本表只判定证据齐备性（存在加形态加哈希自洽），各判据的内容 verdict（红或绿）
归各自代码，本表不替代。8 行全合格为 qualified；任一行不合格为 unqualified。

| 行 | 对象 | 合格条件 | 不合格形态（任一即该行不合格） |
| --- | --- | --- | --- |
| J1 | E1 | 存在且可解析为 JSON 数组（runs 原样形态） | 缺失、解析失败、非数组 |
| J2 | E2 | 存在且含判定输入五键 | 缺失、解析失败、缺键 |
| J3 | E3 | 存在且非空（含汇总行） | 缺失、空文件 |
| J4 | E4 | 存在且非空（判据行镜像） | 缺失、空文件 |
| J5 | E5 | 存在且非空（判据行镜像） | 缺失、空文件 |
| J6 | E6 | 存在且 status 可读（三态之一） | 缺失、解析失败、status 不可读 |
| J7 | E7 | 每行皆为 64 位 hex 加两空格加 tgz 文件名；行数非空 | 缺失、空文件、行形态不符、空集 |
| J8 | E8 | 存在且含待发布包清单行 | 缺失、空文件、无清单行 |

总则与边界：

- 缺任一条即不合格：上表任一行不合格，verdict 即 unqualified（禁发）。
- E3 内出现 FAIL 行、E6 的 status 为 stale 或 unknown，均不由本表判红：
  前者由版本门禁禁发，后者按 W1.4 选A 只存证（见 3 节）；但两者缺失仍走本表判不合格。
  证据缺失与判据失败都禁发，verdict 须区分写明（缺证据不等于判据红）。
- 每项附件 sha256 须与清单登记值一致；不一致按缺失计（损坏或篡改等同缺）。

## 6. G1-G8 说明（验收项，本片只给位置）

- G1-G8 为 3.7 门禁验收项，主控已亲验；本规格直接采用其结论，不重述验收过程，
  不在本片新增执行点。
- 其中 G5 为发布门（Require release notes 步骤：push 发布必须附带人工 notes，
  缺失即红；手动派发仅勾选逃生开关才回落自动生成），代码位置见第 8 节。
- 其余 G 项分属 3.7 验收结论，本片不展开；凡涉执行语义一律以代码为准。
- S1 判定表（第 5 节）只判定证据齐备性，不替代任一 G 项的通过结论；
  G 项判红与证据缺失都禁发，两者并列，verdict 须区分写明。

## 7. R3-ex 关闭记录

- R3-ex（3.7 评审遗留的接线登记缺口：G5 步骤在接线台账无登记）已随 #902 关闭，
  本片采用主控已关闭结论，只记录关闭对应物。
- 关闭对应物为 #902 对接线台账的差分三处：observe-precheck 步骤身份追加落盘旗
  与两处输出路径；priorRunSteps 新增 Require release notes 条目（摘要钉死）；
  两处 jobFaces 摘要刷新（publish job 与 observe-precheck job）。
- 复核只认上述差分符号（第 8 节台账位置）；R3-ex 的评审过程不在本片展开。

## 8. 与 S2 实现的对应关系（W1、G5、台账位置）

| S1 项 | S2 位置 | 说明 |
| --- | --- | --- |
| E1、E2 | W1.5：observe-precheck.mjs（--runs-out、--inputs-out）加 release.yml 的 observe-precheck job（含 Upload precheck evidence 步骤，artifact 名 release-evidence-observe-precheck） | 前置校验的证据落盘面 |
| E3 | W1.1：verify-version.ts（--log-file）加 Verify versions 步骤 | 版本门禁的证据落盘面 |
| E4、E5 | W1.2：pack-check.ts 与 verify-npm-layout.ts（--log-file）加 Pack check 与 Npm layout 步骤 | 产物门禁的证据落盘面 |
| E6 | W1.4：baseline-staleness.mjs（--warn-only、--status-file）加 Baseline evidence 步骤 | 基线取证面，纯存证 |
| E7、E8 | W1.3：collect-tgz-evidence.mjs（SHA_FILENAME、LOG_FILENAME）加 Collect release evidence 步骤；包集合与 Publish to npm 步骤同源（publish-if-missing.ts，见 [publish-if-missing.ts](../../scripts/release/publish-if-missing.ts)） | 发布产物的哈希存证面 |
| 无 E 项对应 | W1.6：Aggregate check 加 Docs check（聚合一致性加文档门） | 只属 G 面，不产出证据文件 |
| G5 | release.yml 的 Require release notes 步骤（人工 notes 路径约定 docs/release-notes 下按 tag 命名） | 发布门，见第 6 节 |
| 台账位置 | [gate-wiring-exceptions.json](../../scripts/data/gate-wiring-exceptions.json)：stepEnvs（observe-precheck 落盘旗逐字登记）、priorRunSteps（G5 步骤摘要）、jobFaces（两 job 摘要） | S2 的接线登记面；#902 同批次的 gauntlet 正式锚回填不属证据束，不在本片对应面内 |

符号出处说明（分歧时以代码为准）：

- 本分支现存、可相对链接的事实源：[release.yml](../../.github/workflows/release.yml)、
  [observe-precheck.mjs](../../scripts/release/observe-precheck.mjs)、
  [verify-version.ts](../../scripts/release/verify-version.ts)、
  [baseline-staleness.mjs](../../scripts/release/baseline-staleness.mjs)、
  [接线台账](../../scripts/data/gate-wiring-exceptions.json)、
  [scripts README](../../scripts/README.md)。
- #902 新增、不在本分支基线内的符号只作符号名引用：collect-tgz-evidence.mjs
  （SHA_FILENAME、LOG_FILENAME、renderShaLines、listPublishSet、parseArgs）、
  pack-check.ts 与 verify-npm-layout.ts 的 --log-file 落盘面、
  release.yml 的证据上传两步骤与 W1.3、W1.4、W1.6、G5 注释编号；
  引用以 #902 提交代码为准。

## 9. 非目标

- 不装配 release-evidence.json 本体（模式先行，实现另立项）；
- 不新增采集脚本，不改 release.yml，不改门禁阈值与判定语义，不碰公共 API；
- 不展开 G1-G8 的验收细节，不展开他线事项；
- 不对已知缺口做实现侧收敛，不新增集中判据；
- 本片零源码改动：packages 下源码、shared、scripts、.github、测试、配置、
  依赖、公共 API 均不在本片触碰范围内。

## 10. 证据与复核方法

- 只读复核命令示例（均不写工作区）：
  git status --porcelain（本片只允许出现本文档路径；同分支另有一件未提交文档
  在攒批，动它即越界）、
  pnpm docs:check（相对链接与命令引用校验）。
- S1 面复核用符号搜索（均只读，不以行号为长期依据）：
  搜 SHA256SUMS 与 LOG_FILENAME 覆盖证据收集面、搜 --runs-out 与 --inputs-out
  覆盖前置落盘面、搜 --log-file 与 --status-file 覆盖门禁落盘面、
  搜 release-evidence 覆盖 release.yml 的证据目录与上传步骤。
- S2 新增符号须在 #902 提交树内复核（本分支未含）：git show 01697200 加路径，
  或切对应分支只读查看，不在本分支手写补文件。
- 门禁语义的唯一出处是门禁代码与数据文件本身；本文档是规格记录，
  语义分歧以它们为准。
