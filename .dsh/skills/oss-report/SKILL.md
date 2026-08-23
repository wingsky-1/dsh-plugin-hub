---
name: oss-report
description: >
  汇总项目健康指标并产出两段式报告（机器信号 + 人工判断）。触发信号：
  "健康报告"、"巡检"、"看看代码债"、"周报"。
  Do NOT trigger for: 单个 issue/PR 的状态查询、CI 失败排查（用 oss-pipeline）。
---

# oss-report — 健康巡检报告

## 数据采集（全部只读）
0. **首选数据源是 health-report issue**（CI 定时生成的机器信号段；见
   `.github/workflows/health-report.yml`，每周一 UTC 02:17 调度 + 手动 dispatch，GitHub 侧已 active）；
   若该 issue 尚未生成（首跑未到 / 无人手动触发），降级为本地自采，且必须在报告头标注
   `数据源：本地采集（health-report.yml 已启用，health issue 暂无）`，避免与未来 CI 口径混淆
1. **质量指标**：本地跑五连门禁取可得指标——smoke 用例数 / typecheck 结论 /
   各包构建产物体积变化；coverage 与变异测试基建启用后升级为
   coverage / CRAP 分布 / mutation score（不主动触发全量 Stryker）
2. **CI 历史**：`gh run list --workflow ci --limit 20 --json conclusion,createdAt`
   ——统计近两周失败率与失败步骤分布
3. **挣扎信号**：扫描近 30 天 PR——同一文件被反复回滚/重写、
   变更半径逐 PR 膨胀、纯测试文件增量远超实现文件（凑断言嫌疑）
4. **规则零命中榜**：哪些 contract/pack 约束连续 N 周从未拦截过任何内容
5. **回顾段信号**（元循环入口，见下节）——熔断与重复模式汇总

## 回顾段（元循环汇总出口）

- 采集 `.dsh/retro/history.jsonl`（oss-pipeline 熔断时落盘的失败上下文）：
  统计同一 rule / 同类失败的复现频次；**同一 rule 30 天内出现在 ≥3 个不同 PR**
  → 判定「同类问题重复」，在报告中产出规程修订提案建议；
- **blocked-human 滞留清单**：列出打标超 72h 未恢复的 issue 及其 `suspended_at`
  挂起点，供维护者决定 resume 或关闭；
- **priority/critical 追认核查**：紧急通道合并超 24h 但原 issue 无决策评审留痕的，
  标记违规并提示补追认；
- 规程修订提案本身走 oss-pipeline 决策段（原 issue 内评审），**冷却期**：
  同一规程文件 14 天内最多提案修订 2 次；每个提案必须附回退指标
  （如人工阻塞率升 20% 则自动提案回退），并强制回答「这个修订会不会过度修复」。

## 报告格式（两段式）

```markdown
## 机器信号段（自动生成，勿改）
- 五连门禁：最近一次全绿结论 + 耗时；smoke 用例数 N
- 近两周 ci 失败率：N/M 次，集中在 <步骤>
- 挣扎信号：<有则列出证据链接>
- 零命中规则：<列表>
- 回顾段：<同类问题重复 / blocked-human 滞留 / 紧急通道追认违规，有则列出>

## 人工判断段（留给维护者填写）
- 这些信号是否构成"Agent 在原地打转"的结论？
- 门禁收紧/放宽建议：<由人决定>
- 是否需要重划包边界：<由人决定>
```

## 边界
- 本 skill 只读 + 产出报告，不改代码、不调阈值、不动门禁配置
- 结论性判断（是否撞墙、是否收紧）永远留给人——机器出信号，人下判断
