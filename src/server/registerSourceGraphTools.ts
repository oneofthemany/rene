import type { Logger } from "pino";

import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import {
  SOURCE_GRAPH_OPERATIONS,
  type CodeGraphProvider,
} from "../codegraph/CodeGraphProvider.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind each source-graph contract to the CodeGraph provider and the session Evidence ledger. */
export const registerSourceGraphTools = (
  server: EvidenceMcpServer,
  provider: CodeGraphProvider,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const operation of SOURCE_GRAPH_OPERATIONS) {
    const contract = toolContract(operation);
    const handler = createEvidenceToolHandler(
      server,
      (input, options) => provider.execute(operation, input, options),
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
