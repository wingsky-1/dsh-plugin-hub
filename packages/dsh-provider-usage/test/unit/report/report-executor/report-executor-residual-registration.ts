import { registerResidualDSuite } from "./report-executor-residual-d-cases.ts";
import { registerResidualESuite } from "./report-executor-residual-e-cases.ts";
import {
  registerResidualFSuite,
  registerResidualGSuite,
  registerResidualHSuite,
} from "./report-executor-residual-fgh.ts";

export function registerResidualCases(): void {
  registerResidualDSuite();
  registerResidualESuite();
  registerResidualFSuite();
  registerResidualGSuite();
  registerResidualHSuite();
}
