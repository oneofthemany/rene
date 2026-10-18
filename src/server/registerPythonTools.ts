import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import type { PythonAnalysisService } from "../application/python/PythonAnalysisService.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import type { Logger } from "pino";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind Python source handlers to their exact named contracts through admission. */
export const registerPythonTools = (
  server: EvidenceMcpServer,
  service: PythonAnalysisService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const name of [
    "inspect_python_client",
    "inspect_python_blocking_calls",
    "inspect_python_docs_drift",
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
