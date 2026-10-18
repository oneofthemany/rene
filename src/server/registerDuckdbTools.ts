import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { DuckdbAnalysisService } from "../application/duckdb/DuckdbAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind DuckDB handlers to their exact named contracts through admission. */
export const registerDuckdbTools = (
  server: EvidenceMcpServer,
  service: DuckdbAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const name of [
    "inspect_duckdb_client",
    "inspect_duckdb_database",
  ] as const) {
    const contract = toolContract(name);
    const handler = createEvidenceToolHandler(
      server,
      (input, options) => service.execute(name, input, options),
      logger,
      recordEvidence,
      withAdmittedAnalysis,
    );
    server.registerTool(
      contract.name,
      toolRegistrationOptions(contract),
      handler(contract),
    );
  }
};
