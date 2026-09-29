# Agent Note: 写面保留 scope/基面机制被否

Status: rejected — 该机制诞生在「整组替换」的世界里，「提交没带某字段 = 用户删了它」当时是对的；改成按字段合并后同个手势有了相反答案，两套并存会让同一份提交拿到两个裁决，而基线对齐还要靠三处形态同步维持

## Problem

issue #1016 的第五个实施步骤（分支 `task/1016-pr5-write-scope`，commit `1d97dbbb`）实现了一套
「本次改动 vs 存量带回」的区分机制，供下游的边界判据（重复 id / URL 写面 / 边界值）接缝用。
它由三部分组成：

- `ChannelWriteScope`（`task/1016-pr5-write-scope@1d97dbbb:packages/dsh-notifier/src/server/config/impl/input/type.ts:72`）：
  三个只读入口 —— `isEdited(channelId, field)`、`isNewChannel(channelId)`、`isEditedAt(index, field)`；
- `baseChannels()`（同 commit 的 `service/index.ts:202`）：基线取「客户端实际看过的那份视图」，
  即 `effective.channels` 过一遍共享面 `canonicalChannelsForCompare`；
- 提交侧再过一遍同一份 `stripChannelEmpties`（同 commit 的 `input/index.ts:297`）——
  凭据字段的空串是在掩码**还原之后**才回到提交侧的，只有基线侧剥不够。

它走了三轮复核（判 P0 / P1 / 通过），定位是**使能面：不据以拒任何东西**，判据结论与不带基线时逐字相同，
只随返回值交出去。它登记的两条盲区写在类型头
（`task/1016-pr5-write-scope@1d97dbbb:packages/dsh-notifier/src/server/config/impl/input/type.ts:45-70`）：
「主动设成服务端默认值」与「原样带回」分不开；重复 id 的「少一条」读不出，
且写面按首条还原会让第二条凭据被静默覆盖。

## Proposal

保留这套 scope/基面机制作为写面判定「本次改动」的唯一口径：每次写先按 id 建基线（基线与提交侧都过同一份
比较规范形），逐字段逐字比对，不等的即本次改动，下游判据只在 `isEdited` 为真的字段上生效。
按字段合并只承担落盘，判据仍走 scope 面。

## Alternatives considered

### 保留 scope/基面机制（本提案，被否）

对方最强的理由：它实测的假阳性是零。同一份磁盘、十种形态、同一组用户手势，换基线取法的三列读数是
user-base 3~8 个字段、裸 effective 0~4 个字段、canon-base **全 0**（`task/1016-pr5-write-scope@1d97dbbb:packages/dsh-notifier/src/server/config/impl/service/index.ts:136-147`）——
另两列不是「差不多对」，是系统性偏，而这套机制已经把偏的那一面关掉了。它还是下游三条边界判据
唯一要接的缝；按字段合并只回答「这次写把什么变成了什么」，回答不了「用户有没有动过这个字段」。

否决，三条理由：

- **同个手势两个答案**。它诞生在 `channels` 整组替换之下，那时 `isEdited` 对「基线里有、提交里没有」的读数是
  `!sameValue(undefined, base[field])` 即 true，注释写得很清楚：「channels 是整组替换，少了一条就是删掉了它」
  （`task/1016-pr5-write-scope@1d97dbbb:packages/dsh-notifier/src/server/config/impl/input/index.ts:321`）。
  按字段合并之后，「提交没带某字段」的答案变成「不动」——`inherited` 记它沿用存量（`merge.ts:299`）。两个机制并存时落盘只有一个结果（合并说了算），
  而任何以 `isEdited` 为闸门的判据会对刚刚被决定保留的值执行拒绝。这不是精度问题，是裁决权冲突。
- **基线对齐要靠三处形态同步维持**。基线侧在 `baseChannels`、提交侧在 `writeScopeOf`、
  比较口径在共享面 `channel-compare.ts`，三处任一漂移就是成片的假阳性——而这三处分属三个模块、两套域。
  按字段合并不需要基线对齐：它按 id 取存量原值，与两侧各自的形态无关。
- **它防不住它自己登记的那条数据损失**。重复 id 下写面按 id 取首条原值会让第二条凭据被静默覆盖，
  这是真实的数据损坏；scope 面既不制造也不掩盖它（掩码还原住在 redact 域，它 diff 0 行），
  也读不出「少了一条」。

全量删除的处置见 Consequences。判定准则一句话：**它回答的问题在按字段合并之后已经有了答案，
而那个答案与它相反。**

### 按字段合并 + `inherited` / `preexisting`（被采纳）

采纳理由：合并面给出的两笔账——「值原样来自存量」与「必填键的缺席本就来自存量」——正好是判据真正需要的两件事，
且各自只对自己的那族判据负责。代价是「主动设成默认值」与「原样带回」仍分不开（要分清得回磁盘比原值），
这条**不靠保留 scope 面解决**，它要的是比对磁盘原值，登记为对称化修复、另立 issue。

## Consequences

- 随本决定删除：`validateSettingsWithBase`、`writeScopeOf`、`ChannelWriteScope`、
  `ScopedValidationResult`、`baseChannels()`，以及 `test/unit/config/service-write-scope-baseline.test.ts`。
- `packages/dsh-notifier/src/shared/channel-compare.ts` **留在原地**：它现在的消费者是客户端 diff 一处，
  文件头与 `stripChannelEmpties` 的注释已把「写面第三个调用点随 scope 面删除」记成现状
  （`packages/dsh-notifier/src/shared/channel-compare.ts:7`、`:53`）。仍住共享面是因为它是对「什么算同一份内容」这一问题的口径文本。
- `test/integration/config-write-scope-roundtrip.test.ts` 改名 `config-merge-roundtrip.test.ts`：
  它断的已是合并而不是 scope，名字留着会让下一个改这段的人以为还有基面机制。
  改名连带三处台账（`scripts/data/mutation-topology.json`、`scripts/test/service-contract-wiring.test.ts`、
  四份派生的 `vitest.stryker.d/*.config.ts`）与 `--min`（81 → 80）。
- **重开这个议题的入口**不是「scope 面」这个名字，而是两条具体问题：判据需要「用户有没有动过这个字段」
  （当前拿不到，且这两笔账分不开）；重复 id 的凭据覆盖（`.agents/notes` 登记为数据损坏，未修）。
- 互链：采纳方的完整记录见
  [dsh-notifier 配置生命周期](../../implemented/architecture/2026-09-30-notifier-config-lifecycle.md)。