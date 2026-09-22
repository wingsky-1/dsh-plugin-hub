// @ts-nocheck
/**
 * dsh-provider-usage — 两端路由契约（host-seams R2 收敛，客户端层归属）。
 *
 * CLIENT（src/client/shared/contract.ts，16 常量）与宿主 ROUTES
 * （src/apply/apply.ts）键集 1:1 且值全等：两边各写一份的失败形态是静默的
 * （对不上只表现成请求 404），故在此处以第二事实源锁定键 + 值双相等
 * （lan 的 test/client-unit/client-routes.test.ts 同构）。
 *
 * 被测对象为真实源码：contract.ts 的 __DSH_ROUTES__ 为宿主构建期 define 注入，
 * 测试环境定义为 undefined（与 unit-detect.test.ts 同款 esbuild 即时打包经
 * data-URI 导入），与生产注入缺失走默认 URL 的回落语义一致。
 * 本文件居 test/client（客户端纯逻辑层）：test/unit 不得直引 src/client
 * 实现面（verify-dir-imports I8① unitImportFaceViolations），宿主 ROUTES 的
 * 引用方在此层允许（判据面只看客户端常量，宿主侧是被比较的期望源）。
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../../src/apply/apply.ts";

const pkgDir = fileURLToPath(new URL("../../", import.meta.url));

const contractBundle = await esbuildBuild({
  entryPoints: [join(pkgDir, "src/client/shared/contract.ts")],
  bundle: true,
  format: "esm",
  write: false,
  logLevel: "silent",
  define: { __DSH_ROUTES__: "undefined" },
});
const contract = await import(
  "data:text/javascript;base64," +
    Buffer.from(contractBundle.outputFiles[0].text).toString("base64")
);

const PAIRS = [
  ["STATS_URL", "stats"],
  ["HISTORY_URL", "history"],
  ["HEALTH_URL", "health"],
  ["TREND_URL", "trend"],
  ["ADAPTERS_URL", "adapters"],
  ["SELECT_URL", "select"],
  ["INSPECT_URL", "inspect"],
  ["ADD_URL", "add"],
  ["UI_CONFIG_URL", "uiConfig"],
  ["EVENTS_URL", "events"],
  ["REPORT_CONFIG_URL", "reportConfig"],
  ["REPORT_MODELS_URL", "reportModels"],
  ["REPORTS_URL", "reports"],
  ["REPORT_DETAIL_URL", "reportDetail"],
  ["REPORT_GENERATE_URL", "reportGenerate"],
  ["REPORT_GENERATE_STATUS_URL", "reportGenerateStatus"],
];

describe("两端路由契约", () => {
  it("客户端 16 常量键集与宿主 ROUTES 键 1:1", () => {
    expect(Object.keys(ROUTES).sort()).toEqual(PAIRS.map(([, k]) => k).sort());
    expect(
      Object.keys(contract)
        .filter((k) => k.endsWith("_URL"))
        .sort(),
    ).toEqual(PAIRS.map(([c]) => c).sort());
  });

  it("注入优先（__DSH_ROUTES__ 存在时取注入值）", async () => {
    const injected = await esbuildBuild({
      entryPoints: [join(pkgDir, "src/client/shared/contract.ts")],
      bundle: true,
      format: "esm",
      write: false,
      logLevel: "silent",
      define: { __DSH_ROUTES__: '{"stats":"/injected-stats"}' },
    });
    const mod = await import(
      "data:text/javascript;base64," + Buffer.from(injected.outputFiles[0].text).toString("base64")
    );
    expect(mod.STATS_URL).toBe("/injected-stats");
    expect(mod.HISTORY_URL).toBe(ROUTES.history);
  });

  it("16 对值全等（任一漂移即请求 404）", () => {
    for (const [constName, routeKey] of PAIRS) {
      expect(contract[constName], constName).toBe(ROUTES[routeKey]);
    }
  });
});
