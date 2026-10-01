# Agent Note: #1016 残留四项 —— 清空的可答性、两条不可达的文案、一条会毁凭据的身份

Status: implemented

## Problem

PR #1092 合入后，issue #1016 还剩四项残留。前两项是**同一类**——某条失败或某条状态在链路上被吞掉，
于是界面给出一个与事实相反的答案；后两项是**同一类**——某个分支从未被任何判据覆盖，带着缺陷合了
进来。四项都可在 `origin/main` 上复现。

1. **history clear 写失败仍返 200（假成功）**。`clear()` 调 `writeTextAtomic` 得 `{ok:false}` 时只
   `logger.warn` 然后 `return removed`，端点于是发 `{ok:true, removed:N}`。UI 提示「已清空 N 条」，
   刷新后旧记录全在。**附带一条真数据竞态**：`clear()` 不进 `this.queue`（`append()` 进），一次在飞的
   append 若恰好插在「读旧行」与「写回」之间，清空把文件截空之后它会把整段旧记录原样写回。

2. **403 永久 loading**。设置卡的早退分支 `if (!settings)` 只渲染 `t("settingsLoading")`；而
   `loadCard()` 的 catch 确实把失败填进了 `saved`，只是底部状态行在早退**之后**才渲染。局域网直连被
   回环围栏 403 时，`loadFail` 的提示连同 `lanAccessHint` 的 HTTPS/隧道引导都到不了屏上。

3. **`request-failed` 未本地化**。该 catch 里 `reason: failure.message` 是英文原文，而
   `dryRunStatusTextOf` 的已知值表里没有 `request-failed`，于是 `return status` 又把状态词原样透出——
   一行里两处英文。

4. **channel id 重复**。`validateChannels` 逐条校验后直接返回，没有任何 id 唯一性判据。而设置页对
   `channels` 是**整组提交**，合并的 `sameKindBase` 按裸 id 取首条、KEEP 分支让其余键沿用首条的值：
   **每次保存都毁掉一条凭据**。更糟的是升级步的判据 #7 会在升级那一刻**静默删掉重复条目并写盘**。

## Decision

### 清空：进写队列 + 返回两态，端点固定文案

`clear()` 改 `Promise<ClearOutcome>`（`stores/impl/history/type.ts:40`），并**与 append 共用一条写队列**
（`stores/impl/history/index.ts:136`、`append` 在 `:74`、`enqueue` 在 `:176`）。入队写法照抄 config 域的 `enqueue`：

- `.then(task, task)`：前一次无论成败后一次都跑；
- `result.then(NOOP, NOOP)` **赋回队列**——append 的 task 自己 try/catch 了，clear 的 task 若在兜底之外
  抛出，一个 rejected promise 留在队列上会让**此后每一条历史都静默不写**；
- task 内绝不能再入队（enqueue 同步把队列设成 `result.then(...)`，task 里再入队就是等自己刚挂上去的 tail）。

`append()` 一并改走 `enqueue`：护栏落在入队口一次，就不必在两条写上各记得一次。

**为什么不抛错**（决定性理由）：抛错经 `api/impl/route/index.ts` 的 `reportFailure` 回 500，且 `error`
字段是 Node 错误消息原文，形态是「EACCES: permission denied, rename '<用户主目录>/…'」——直接违反 issue
验收「errno/绝对路径不外送」。故端点 `respond`（`api/impl/journal/index.ts:64`）回 503 + 固定文案 +
`code: "history-unavailable"`，成功体逐字不变。

### 两条文案：复用已内建的事实，不新造状态

早退分支两态化，判据用 `saved.err`——它**已内建**（`setSaved` 的第二参），且 `SettingsCard` 无 props、
早退分支拿得到。零新增 locale key：`saved.msg` 在 catch 里已由 `t("loadFail", {msg, hint})` 填好，
403 时 hint 就是本地化的局域网引导。

`request-failed` 加 1 个 locale key（`testRequestFail`），形态照抄同一个 catch 里既有的「本地化前缀 +
英文原文」范式（`toast(t("testFail", …))`）。状态标签复用既有的 `chStatusSkipped`（「未发出」/ "Not sent"）——
**不是** `chStatusFailed`（「投递失败」/ "Failed"）：`request-failed` 的事实是请求层压根没发出去，
投递面没被触达，标成「投递失败」是**事实性错误断言**，会让用户照着「Bark 端点拒了 / 凭据错了」
排查而真正原因在请求层。零新增 locale key；`chAdd` 生成的 id 恒为 `bark-N` 且自带去重，
客户端造不出重复身份，故 UI 侧无回归面。

### 身份唯一：三处成套，且升级步**反转**

- **写面绝对 400**（`config/impl/input/index.ts:453`）。落点是 `validateChannels` 而**不是**
  `validateChannel`：后者是 exported、给 dry-run 逐条调用的，它看不到数组。
- **投递投影按身份取首项**（`config/impl/input/index.ts:838`）。**这里此前写的「与 `builtinRaw` /
  `indexById` / `findById` 同一口径」不成立**，已改：三把尺各不相同——投递投影是
  `id || type`（无 id 回落 type）按**数组序**取首条；合并的 `indexById`（`service/merge.ts:460`）与掩码
  还原的 `findById`（`redact/index.ts:151`）是**只按裸 id**，没有非空 id 的条目根本不进索引；
  `builtinRaw`（`input/index.ts:870`）是**只按 type**，完全无视 id。三者只在「内置条目都带 id、用户
  条目都带唯一 id」这一种常见形态下碰巧同形，其余形态各说各话。B / C 两个形状见「已知缺口」。
- **升级步去掉去重**（`upgrade/impl/steps/canonical-keys.ts:252`）——这是**行为反转**，不是新增。

身份口径统一为 `typeof id === "string" && id !== "" ? id : type`（与 upgrade 域原 `identityOf` 同式，
该函数随去重一并删除）。它同时满足「拒跨类型」「拒同类型同 id」「拒两条内置 browser」，且内置 id 缺席
时回落 type ⇒ **零误伤现有合法配置**。

## Consequences

- **收益**：清空这条链路上「成功」从此只表示「真的清掉了」；append/clear 的次序由队列决定、与 fs 调度
  无关；403 用户第一次能看到出路；dry-run 请求层失败不再两处英文；重复身份从「每次保存静默毁一条凭据」
  变成「保存时被 400 拦下、提示告诉用户删哪一条」。
- **代价**：`clearHistory` 的签名变了（`stores/interface.ts:49`），`StorePort` 是 `Pick<typeof storesApi, …>`
  故自动跟随，`api/deps.ts` 零改动；测试里的假件要跟着改形态。
- **承重不变式（三条，缺一即开新洞）**：
  1. 清空的**返回值形态**与端点的 **503 映射**必须一起改——只改一边就会出现「端点把 `ok:false` 的结果
     按成功发出」或「端点按数字拼 `removed`」。
  2. 写面 400 与升级步不去重必须**同时**成立：只留 400 而不去重，升级会在用户看不见的地方删掉第二条；
     只去掉重而不加 400，手改文件能一路走到投递面双投。
  3. 投递投影取首项只防**双投**，不防数据消失——它绝不改磁盘；**代价是落选的那条从此不再投递**
     （仍留在磁盘、仍画在设置页上，删它要走写面 400 那条路）。
- **边界**：升级步**不去重**意味着「磁盘上已经有重复身份」的状态会被原样保留，这是有意的：视图原样外发
  ⇒ 设置页画出两张卡 ⇒ 用户删一张（`chDelete` 有二次确认）再保存即通过。**没有任何一条路会隐藏或删除
  任何东西。**
- **登记的已知缺口（四条）**：
  1. dry-run 的 `draft/index.ts` 逐条调 `validateChannel`、看不到数组，故重复身份的草稿仍能试发
     （会双投）。dry-run 是零落盘只读通道，最坏是「试发时两条都收到同一条通知」，超出本 PR 范围。
  2. **投递投影的 B / C 两个形状是本轮明确接受的取舍**（`seen.add` 在 `asChannel` **之前**）：
     - B 跨类型重复：内置 browser 在前 + 一条 id 为 `browser` 的 bark ⇒ 该 bark 整条不进投递池，
       barks 从 1 变 0。
     - C 半坏条目前置：`baseUrl` / `deviceKey` 为空串的条目（0.2.9 升级步按设计**保留**它）先占掉
       身份，后面一条健康的同 id 条目被挤出去，barks 从 1 变 0。
     - 对照：形状 A（同 id 两条都有效）2→1，是本轮要的收益；形状 D（健康条在前）1→1 不变。
     **两条都以「重复身份」为前提**：写面已绝对 400、客户端 `chAdd` 恒生成 `bark-N` 且自带去重，
     故 UI 造不出这种配置，只剩手改文件与 0.2.9 之前的存量。
     **本轮刻意不改 `seen.add` 的位置**：挪到 `asChannel` 之后会让 B 从 0 变 1（让用户那条 bark
     赢过内置条目），那是**另一套语义**、需要单独决策；而 C 的收益不足以在本 PR 里换掉那个未定的
     语义。登记为缺口比顺手改对更诚实。
  3. **写队列的 `enqueue` 是双重冗余护栏，两条都无单独判据**（`stores/impl/history/index.ts:176`）。
     `.then(task, task)` 与 `result.then(NOOP, NOOP)` **各自**都足以挡住「一次抛错 ⇒ 此后每条历史
     都静默不写」，因此单独改掉任何一条全都不红（实测：单去中和 exit 0 / 单退回 `.then(task)` exit 0 /
     两条同去 exit 1 且只红新增的那一条）。已补的判据断的是**性质**（抛错后后续写仍落盘），断不了
     某一条写法。相应地，源码注释里「rejection 留在队列上会让后续 append 被跳过」这句**在当前双分支
     写法下不成立**（那个症状要退回单分支 `.then(task)` 才出现），已改成如实描述。
     config 域的同名方法（`config/impl/service/index.ts:200`）是同一写法、同样零判据，未动。
  4. `chStatusFailed` 与 `chStatusSkipped` 在 `request-failed` 上**有意一格两义**：两者都表示
     「未送达」，但分属请求层与投递层，靠紧邻的理由行（`testRequestFail` 前缀）区分。若将来觉得含糊，
     该做的是给理由行补一句而不是换回「投递失败」——后者断言了一件没发生的事。

## Testing

每条新判据都做过「改坏 → 只它红 → 还原 → 绿」，**判据**与**被改坏的那一行**都记在这里：

- 清空次序（`test/unit/stores/history.test.ts`）：把 `clear()` 改回不进队列 → exit 1，**只红**两条次序判据
  （append→clear→append、两次 clear 夹 append），其余 1547 绿。
- 清空失败态：把 503 改回 200 → exit 1，**只红** 1 条（`DELETE /history` 503 + code）。
- 原因不外送：把 `written.reason` 塞进返回值 → exit 1，红 4 条，含「返回值里没有 errno 与绝对路径」。
  该判据用只读目录（0o555）排故障——那里才真的有一条带绝对路径的 Node 消息可漏；用「路径被目录占住」
  的夹具排不出这个形状（那样连读面也读不出来）。
- 早退分支第三态：把三元表达式改成 `{t("settingsLoading")}` → exit 1，**只红** 1 条。**这条判据第一版是
  恒真的**：源码扫描切的是整段早退块，而那段上方的解释性注释里恰好写着 `saved.err`，`toContain` 被注释
  满足。现已统一走 `codeOnly()` 先剥 `//` 注释行再断言。
- dry-run 文案：`reason` 改回 `failure.message` → exit 1 只红 1 条；删掉 `dryRunStatusTextOf` 里那条映射
  → exit 1 只红 1 条。
- 状态标签的 key 收窄（`:277` 的正则由 `[a-zA-Z]+` 钉成 `chStatusSkipped`）：把实现改回
  `chStatusOk` → exit 1，只红那一条。此前的不钉写法对 `chStatusOk` / `chStatusFailed` 一律绿。
- 队列抗污染（`test/unit/stores/history.test.ts` 新增一条，判据是**性质**不是写法）：单去
  `result.then(NOOP, NOOP)` → **exit 0**；单退回 `.then(task)` → **exit 0**；两条同去 → exit 1 且只红
  这条新用例。三次实测的结论就是「已知缺口」第 3 条：**两条机制冗余，单改任一条判不出来**。
  写这条判据时踩到的排法：清空的写入故障要靠「把历史文件占成目录」造，故必须等那次清空
  **真的抛完**再把位置腾出来——同步就腾的话清空自己也会写成功，`logger.warn` 根本走不到，
  整个故障注入退化成恒真。
- 身份唯一：把 `requireUniqueIdentities` 的命中条件短路 → exit 1，红 5 条（全是新增的写面判据）；
  短路投递投影的去重 → exit 1，红 2 条；把升级步的去重装回去 → exit 1，红 2 条判据 #7。
- 判据 #7 的改写有一处**自查拦截**：第二版写的「重复身份不重写文件」是装饰性断言（`clean()` 不暴露
  `touched`，改回去也绿），已换成「重复身份的那一条仍照常清陌生键」——专钉「去掉 `seenIds` 时把 `continue`
  提到 `cleanEntry` 之前」这个改法方向。
- 工具坑两则（供后续实施者）：`pnpm test | head -N` 会因 SIGPIPE 把退出码吃掉成 0，必须 `> log 2>&1;
  echo $?`；用 read+write 做探针时 read 的行数上限会截断长文件（`index.tsx` 1981 行），探针一律走 edit
  工具或 cp 备份。
