import {
  registerB3aSuite,
  registerReasoningEffortSuite,
} from "./report-executor-generation-suites.ts";

export function registerGenerationCases(): void {
  registerReasoningEffortSuite();
  registerB3aSuite();
}
