# 跨 skill 工作流共享纪律（唯一事实源）

> 用途：阶段式 commit、文档同步、commit-only 工作模式、跨 skill 交接指针的**唯一事实源**。
> 各 skill（review / hub-dev / dev / open-source）在对应节「引用本文件」，**不各自内联**
> 重复定义——改一处生效，避免多 skill 漂移。
> 来源：dsh-plugin-review + dsh-notifier 工作流复盘（OPTIMIZATION-NOTES-2026-08）。

---

## 1. 阶段式门禁 + 阶段 commit（每逻辑阶段一次）

- 每个逻辑阶段（如「一次评审项修复」「一个里程碑」）结束时**独立收口**：
  1. 全量门禁跑绿（hub 通用：`pnpm build && pnpm test && pnpm contract && pnpm pack:check`；
     主仓见 `dsh-plugin-dev` §4 验证流程）；
  2. 工作树/产物核对（编入库的 `lib/` 与源码一致、无游离 css/临时文件）；
  3. **阶段 commit**（一句话改什么、为什么），不攒到最后一次性提交。
- 好处：每阶段可审、可回滚、可单独验收；失败定位到阶段而非整批。

## 2. 文档/注释与实现同 commit 同步

- 行为改动的同时，同步更新：README 实现段、JSDoc/文件头注释、配置样例、
  契约/路线断言。**同一 commit 内**完成，不把文档漂移留成债。
- 自查触发：任何「加配置键 / 改路由 / 改行为」的改动，commit 前 grep 一遍
  README/注释是否还描述旧行为。

## 3. commit-only 工作模式（实施期可选默认推荐）

- **commit-only**：每里程碑**本地 commit + 门禁全绿**，**不 push、不 publish**；
  push/发布由**用户最终统一验收并显式触发**。
- 何时用：长周期分阶段实施、多轮追加需求、用户想先攒批再统一验收时，默认推荐。
- 长周期多里程碑实施可**用会话级 create_goal 承接**（跨轮自动推进），里程碑各自门禁收口。
- 何时切正式发布：用户明确说「发布 / push / 打 tag」时，才切到
  `dsh-plugin-open-source` 的正式发布模式（bump + tag + push + npm）。
- 红线：agent 不代 push、不代发布、不代重启 dsh web（重启由用户/平台执行）。

## 4. 跨 skill 交接指针（职责分层）

```
review（评审/计划） → 落地计划 + REVIEW-AND-PLAN 交接物 → 用户批准
   → 转入 hub-dev（公开仓）/ dev（主仓） 实施（§3 commit-only）
   → 完成实施 → open-source（发布，由用户显式触发）
```

- review 是纯只读：只产出计划与交接物，**不内联**实施细节（commit/门禁/常见坑）。
- 实施细节（阶段 commit、运行时确认、配置四同步、实施坑）由 dev/hub-dev 承载；
  发布衔接由 open-source 承载——各 skill 见对应节，不越界。

## 5. 实施期高频坑 checklist（评审→实施过渡常见）

- 正则改写易**吞相邻字符/后缀符**（如替换时未锚定边界）→ 用捕获组显式锚定 + 用例覆盖。
- `setInterval`/`setTimeout` 残留使测试进程不退出 → 窗口定时器 `unref()`；
  窗口类逻辑测试用**独立 apply + 短窗口配置 + 短 await**，不引全局 sleep。
- 新配置键**四同步**：normalize 白名单 / 透传排除表 + 客户端渲染 + smoke 断言 +
  README 样例（漏一项即被 `unknown 键透传` 覆盖归一化或契约不同步）。
- `querySelector` 返回 `Element` 无 `hidden` 属性类型 → DOM 类型断言或判空后再用。
- 子进程 spawn 的 kill 只杀主进程、残留子进程 → 进程树清理
  （Unix `kill(-pid)` + `detached:true` 进程组 / Win `taskkill /pid <id> /T /F`）。
- 改 client 后验证前先核对**运行时加载产物与构建产物一致**（见 `verify-checklist.md` §4
  运行时确认；重启由用户/平台执行，agent 不代操作）。

> 以上定义为跨 skill 共享事实；具体 skill **默认只引用本条**，不复制全文。特殊情况下
> （某 skill 是该规则的高频触发点，如 hub-dev 的实施节）可就近重申一行要点，但必须以
> 本文件为**权威版本**——两处同时改动时须同步，避免漂移。