import {
  registerConfigFailureSuite,
  registerReportConfigSuites,
  registerReportIdempotencySuite,
  registerReportQuerySuite,
} from "./report-executor-config-suites.ts";

export function registerConfigCases(): void {
  registerReportConfigSuites();
  registerConfigFailureSuite();
  registerReportIdempotencySuite();
  registerReportQuerySuite();
}
