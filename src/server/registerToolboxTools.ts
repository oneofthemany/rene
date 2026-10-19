import type { Logger } from "pino";

import {
  TOOLBOX_OPERATIONS,
  type ToolboxService,
} from "../application/toolbox/ToolboxService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind each toolbox contract to its workflow and the session Evidence ledger. */
export const registerToolboxTools = (
  server: EvidenceMcpServer,
  service: ToolboxService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  for (const operation of TOOLBOX_OPERATIONS) {
    const contract = toolContract(operation);
    const handler = createEvidenceToolHandler(
      server,
      (input, options) => service.execute(operation, input, options),
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
