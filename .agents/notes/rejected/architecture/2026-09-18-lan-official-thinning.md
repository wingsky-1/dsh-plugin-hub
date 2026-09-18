# Agent Note: 退回官方薄接入、退役 lan-proxy 转发层

Status: rejected — 官方能力覆盖不了 TLS/压缩/WebSocket 转发需求，保留插件并设复核触发

## Problem

dsh 自带局域网相关能力（如 `--trusted-host`）与本插件转发层存在重叠，是否有必要长期自持一套 TLS/压缩/WebSocket 转发。

## Proposal

退役 `dsh-lan-proxy` 转发层，局域网场景只用官方能力（`--trusted-host` 等），插件仅保留文档指引。

## Alternatives considered

- 保留完整转发层（被采纳）：TLS 终止、压缩协商、WebSocket 转发与 loopback 安全语义是官方能力当时给不出的部分，评估见 [official-lan-access-overlap-assessment](../../../../packages/dsh-lan-proxy/docs/official-lan-access-overlap-assessment.md)（§六判定依据、§七重新评估触发条件）。官方能力变化时按§七重估。
- 部分退役（只退压缩或只退 TLS）：省的维护量小，切口反而增加两套行为的组合矩阵，被否。

## Risks

若 dsh 后续版本补齐上述能力，本否决需重审；重审入口是 assessment 文 §七重新评估触发条件，不是重起炉灶。
