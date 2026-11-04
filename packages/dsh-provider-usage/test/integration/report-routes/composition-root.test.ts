/**
 * dsh-provider-usage — integration：报告路由域组合根四维度 + 释放验收（#768 计划表 rev2 D11 验收）。
 *
 * 白盒直连 src（经 server/report-routes 门面活装配 + 实现直引同一性）；落盘一律进
 * mkdtemp 隔离目录（产物零污染；路径禁令：本文件无家目录调用，走 dshHome 接缝检查由
 * gate:homedir 门禁覆盖）。离线：桩队列/配置服务/ctx 全内存，不起端口、不触 DSH_HOME、
 * 不读真实凭据。
 * 四维度 + 一验收：
 * - D11一 经 server/report-routes 域门面装配：六 handler + create + 三白名单只经
 *   server/report-routes/interface.ts，不走旧 domain2/routes 入口；apply/apply.ts
 *   的路由消费与 apply/index.ts 的 status 转发收口新门面；旧 domain2 面不再转发
 *   报告符号；门面禁整文件 re-export；创建面不进包导出面。
 * - D11二 配置服务窄面消费 + 任务队列 + 执行器：context 两字段为 deps.ts 窄口
 *   （ReportRoutesConfigPort = get/update，ReportRoutesQueuePort = submit/get）；
 *   只暴露窄口方法的桩跑通全部 handler（多用一能力即 TypeError 先红）；真实例
 *   （ReportConfigService/ReportTaskQueue）可赋值窄口（tsc 编译面）；deps.ts
 *   纯类型面运行时零出口；执行器工厂不直引（实现内无 makeDueReportExecutor/
 *   DueExecutorDeps）；装配面转发消除、锚点已删除（#768 D13 删 apply/interface.ts
 *   空门面：dir-imports 基线（apply 模块归属消失）+ 本文件 D11二存在性断言已同步更新）。
 * - D11三 围栏与正路：六端点非回环 + 错方法仍 403（顺序反了即 405 泄漏）；
 *   回环 + 错方法 405 且文案逐字节锁定；回环 + 正方法放行（config/reports 200，
 *   generate 202，status 未知任务 404）。
 * - D11四 释放顺序锁定 + 复位标记 + 路由单点 + 客户端契约：释放顺序锁定
 *  （routes 首释 + stats → trend → scheduler，改序即红；仅首位与装配逆序，
 *  非严格全逆序——见 D11四注记）；同进程重装配先复位标记
 *  （releaseUpgrade 缺失或晚于 install 即红）；reportScheduler 释放成对；
 *   创建面路径即 ROUTES 单点（实现内无硬编码 /api/ 字面量）；客户端六键回指同源
 *   （host-seams R2 收敛后字面量只留 client/shared/contract.ts 一份，缺键即分叉）。
 *
 * 每条附判据句（把 X 改坏必须红）；文本哨兵仅锚真实 ABI 与装配关系，不做风格断言。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerReportRoutesWiringCases } from "./report-routes-composition-wiring.ts";
import { registerReportRoutesHandlerCases } from "./report-routes-composition-handlers.ts";
import { registerReportRoutesFenceCases } from "./report-routes-composition-fence.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "..", "..", "src");
const repoRoot = join(here, "..", "..", "..", "..", "..");
const readText = (p: string): string => readFileSync(p, "utf8");
const applySrc = readText(join(srcDir, "apply", "apply.ts"));
const applyFaceSrc = readText(join(srcDir, "apply", "index.ts"));
// #768 D13：空锚点 src/domain2/routes/interface.ts 已删（ui 四块 D12 起归 server/ui-routes），本文件不再读旧面。
const reportFaceSrc = readText(join(srcDir, "server", "report-routes", "interface.ts"));
const reportDepsSrc = readText(join(srcDir, "server", "report-routes", "deps.ts"));
const reportsSrc = readText(join(srcDir, "server", "report-routes", "reports.ts"));
// host-seams R2 收敛后客户端字面量只留 client/shared/contract.ts 一份（core/report 改经具名表 import）。
const clientContractSrc = readText(join(srcDir, "client", "shared", "contract.ts"));
const topologySrc = readText(join(repoRoot, "scripts", "data", "mutation-topology.json"));
const strykerRoutesSrc = readText(
  join(repoRoot, "stryker.conf.d", "dsh-provider-usage-routes.json"),
);

registerReportRoutesWiringCases({
  applySrc,
  applyFaceSrc,
  reportFaceSrc,
  reportDepsSrc,
  reportsSrc,
  topologySrc,
  strykerRoutesSrc,
  srcDir,
});

registerReportRoutesHandlerCases({
  applySrc,
  reportsSrc,
  reportFaceSrc,
  reportDepsSrc,
  srcDir,
});

registerReportRoutesFenceCases({
  applySrc,
  reportsSrc,
  clientContractSrc,
});
