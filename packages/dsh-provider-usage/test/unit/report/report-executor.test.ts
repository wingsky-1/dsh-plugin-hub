import { registerConfigCases } from "./report-executor/report-executor-config-registration.ts";
import { registerGenerationCases } from "./report-executor/report-executor-generation-registration.ts";
import { registerTransactionCases } from "./report-executor/report-executor-transaction-registration.ts";
import { registerPolicyCases } from "./report-executor/report-executor-policy-registration.ts";
import { registerLedgerCases } from "./report-executor/report-executor-ledger-registration.ts";
import { registerResidualCases } from "./report-executor/report-executor-residual-registration.ts";

registerConfigCases();
registerGenerationCases();
registerTransactionCases();
registerPolicyCases();
registerLedgerCases();
registerResidualCases();
