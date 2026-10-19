import type { Logger } from "pino";

import type { ProjectSurveyService } from "../application/projectSurvey/ProjectSurveyService.js";
import type { EvidenceWriter } from "../application/investigation/InvestigationRecordPort.js";
import { toolContract } from "../contracts/toolContracts.js";
import type { WithAdmittedAnalysis } from "./analysisAdmission.js";
import { createEvidenceToolHandler } from "./contractToolHandler.js";
import type { EvidenceMcpServer } from "./EvidenceMcpServer.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";

/** Bind the project survey contract to its workflow and the session Evidence ledger. */
export const registerProjectSurveyTools = (
  server: EvidenceMcpServer,
  service: ProjectSurveyService,
  logger: Logger,
  recordEvidence?: EvidenceWriter["recordEvidence"],
  withAdmittedAnalysis?: WithAdmittedAnalysis,
): void => {
  const contract = toolContract("survey_project_directory");
  const handler = createEvidenceToolHandler(
    server,
    (input, options) => service.survey(input, options),
    logger,
    recordEvidence,
    withAdmittedAnalysis,
  );
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    handler(contract),
  );
};
