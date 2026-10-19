import type { McpServer, ServerContext } from "@modelcontextprotocol/server";
import type { Logger } from "pino";

import type { BrowserSessionManager } from "../browser/BrowserSessionManager.js";
import { toolContract } from "../contracts/toolContracts.js";
import { logToolExecution } from "./toolLogging.js";
import { toolRegistrationOptions } from "./toolRegistrationOptions.js";
import type { ToolResultDelivery } from "./toolResult.js";

export type BrowserSessionToolManager = Pick<
  BrowserSessionManager,
  "start" | "status" | "close"
>;

/** Register REA-owned browser sessions for CDP observation tools. */
export const registerBrowserSessionTools = (
  server: McpServer,
  manager: BrowserSessionToolManager,
  logger: Logger,
  delivery: ToolResultDelivery,
): void => {
  const start = toolContract("start_browser_session");
  const status = toolContract("browser_session_status");
  const close = toolContract("close_browser_session");
  server.registerTool(
    start.name,
    toolRegistrationOptions(start),
    async (input, context: ServerContext) =>
      delivery.toCallToolResult(
        await logToolExecution(logger, start.name, () =>
          manager.start(
            {
              executablePath: input.executable_path,
              startUrl: input.start_url,
              headless: input.headless,
            },
            context.mcpReq.signal,
          ),
        ),
        start,
      ),
  );
  server.registerTool(
    status.name,
    toolRegistrationOptions(status),
    async (input) =>
      delivery.toCallToolResult(await manager.status(input.session_id), status),
  );
  server.registerTool(
    close.name,
    toolRegistrationOptions(close),
    async (input) =>
      delivery.toCallToolResult(
        await logToolExecution(logger, close.name, () =>
          manager.close(input.session_id),
        ),
        close,
      ),
  );
};
