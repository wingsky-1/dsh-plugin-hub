/**
 * report-routes 组合根：D11二 的源码边界与家目录禁令。
 *
 * 由原入口在 D11二 父 describe 内、handler 行为面之后同步注册；不改变测试全名或顺序。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

export interface ReportRoutesSourceContractSources {
  applySrc: string;
  reportsSrc: string;
  reportFaceSrc: string;
  reportDepsSrc: string;
  srcDir: string;
}

export function registerReportRoutesSourceContractCases(
  src: ReportRoutesSourceContractSources,
): void {
  const { applySrc, reportsSrc, reportFaceSrc, reportDepsSrc, srcDir } = src;
  it("执行器工厂不直引（实现内无执行器符号，越界即红）", () => {
    expect(reportsSrc.includes("makeDueReportExecutor")).toBe(false);
    expect(reportsSrc.includes("DueExecutorDeps")).toBe(false);
    expect(reportsSrc.includes("ReportTaskQueueOptions")).toBe(false);
  });

  it("装配面锚点已删除（复活即类型倒灌回退）", () => {
    expect(existsSync(join(srcDir, "apply", "interface.ts"))).toBe(false);
    expect(applySrc.includes("apply/interface")).toBe(false);
    expect(reportsSrc.includes("apply/interface")).toBe(false);
  });

  it("家目录禁令：三文件无 homedir/HOME/untildify 直调（直调即红）", () => {
    for (const source of [reportsSrc, reportFaceSrc, reportDepsSrc]) {
      expect(source.includes("homedir(")).toBe(false);
      expect(source.includes("process.env.HOME")).toBe(false);
      expect(source.includes("untildify")).toBe(false);
    }
  });
}
