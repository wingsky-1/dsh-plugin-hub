// Shape-only support module; all executable assertion bodies are moved verbatim.
import { describe } from "vitest";
import { registerExecutorEntryCases } from "./report-executor-transaction-cases-1.ts";
import { registerExecutorEffortCase } from "./report-executor-transaction-cases-1.ts";
import { registerExecutorRouteFailureCase } from "./report-executor-transaction-cases-1.ts";
import { registerExecutorNoDataCase } from "./report-executor-transaction-cases-1.ts";
import { registerExecutorUsageCases } from "./report-executor-transaction-cases-2.ts";
import { registerExecutorCommitCases } from "./report-executor-transaction-cases-2.ts";
import { registerExecutorPersistCase } from "./report-executor-transaction-cases-2.ts";
import { registerExecutorAbortCase } from "./report-executor-transaction-cases-2.ts";
import { registerExecutorIndexCases } from "./report-executor-transaction-cases-3.ts";
import { registerExecutorClaimBeforeForceCase } from "./report-executor-transaction-cases-3.ts";
import { registerExecutorSuccessCasCase } from "./report-executor-transaction-cases-3.ts";
import { registerExecutorPersistFenceCase } from "./report-executor-transaction-cases-3.ts";
import { registerExecutorFailureCasCase } from "./report-executor-transaction-cases-3.ts";

export function registerExecutorTransactionsSuite(): void {
  describe("runner/executor：#1010 B2a retry ledger 执行事务", () => {
    registerExecutorEntryCases();
    registerExecutorEffortCase();
    registerExecutorRouteFailureCase();
    registerExecutorNoDataCase();
    registerExecutorUsageCases();
    registerExecutorCommitCases();
    registerExecutorPersistCase();
    registerExecutorAbortCase();
    registerExecutorIndexCases();
    registerExecutorClaimBeforeForceCase();
    registerExecutorSuccessCasCase();
    registerExecutorPersistFenceCase();
    registerExecutorFailureCasCase();
  });
}
