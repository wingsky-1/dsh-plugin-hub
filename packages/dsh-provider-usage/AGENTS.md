# AGENTS.md — dsh-provider-usage 包规则

> 本文件是 `@wingsky-1/dsh-provider-usage` 的**包级规范**（叠加层）。改动本包
> `src/`、`test/`、`cordis.patch.yml`、`package.json` 前必读。上层规则见仓库根
> `AGENTS.md`（硬性）与 `docs/DEVELOPMENT.md`（权威详细版）。

## 定位

多 provider 用量悬浮框（v2 宿主渲染，客户端只挂载框架）。

## 改动前必守（本包特有）

1. **适配器即全权限**：适配器代码以宿主完整 Node 权限运行，只加载信任的本地文件，
   绝不从网络拉取代码执行。
2. **密钥不进端**：密钥不出宿主，三级密钥链，响应体无密钥子串；`fetchData` 恒 5 秒
   不可配置；报告零独立凭据，产物落盘 0600＋basename 化。
3. **先转义后清洗**：XSS 防护为转义＋清洗双层，清洗失败即 fail-closed，不得降级放行。
4. **新路由先登记**：新增路由先在 `src/apply/apply.ts` 的 `ROUTES` 单点登记，
   全部 loopback 围栏。
5. **路径走接缝**：用户形态路径不直接展开，一律走路径解析与 `dsh-home` 接缝；
   状态文件原子写＋取证备份。
6. **改默认偏移先联动**：悬浮框默认偏移依赖他包浮窗位置，改动前先联动评估。

## 验证（提交前全跑）

> 完成定义以根 [AGENTS.md 门禁矩阵](../../AGENTS.md) 为**单一事实源**。

```sh
pnpm build && pnpm test
```

包 `test` 为 `run-vitest.mjs --min 20`（含 `prepare-lib-entry` 构建链）；路由围栏用例必带。

## 提交

Conventional Commits（如 `fix(dsh-provider-usage): ...`），中文 subject，禁 emoji；
安全语义变更须同步 README 的「安全模型」节与测试。
