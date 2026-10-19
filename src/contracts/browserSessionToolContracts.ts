import { z } from "zod";

import { localPathStringSchema } from "../domain/localPath.js";
import type { ToolContract } from "./toolContractTypes.js";
import { toolContractMetadata } from "./toolEffects.js";

const sessionId = z.string().uuid();
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), {
    message: "Expected an http or https URL.",
  });
const target = z.strictObject({
  target_id: z.string(),
  type: z.string(),
  url: z.string(),
  title: z.string(),
});

/** Browser sessions REA owns so CDP observation tools can attach to them. */
export const BROWSER_SESSION_TOOL_CONTRACTS = [
  {
    name: "start_browser_session",
    ...toolContractMetadata("start_browser_session"),
    kind: "browser-provider",
    description:
      "Start a caller-selected Chromium executable with a private temporary profile and a loopback DevTools port, open start_url, and keep the browser running for a person or agent to operate. Returns the session_id and the cdp_endpoint (http://127.0.0.1:PORT) to pass to list_browser_targets, observe_web_session, inspect_web_page, observe_web_execution or capture_web_screenshot. Headed by default; a window needs a display (Wayland or X11) in REA's environment. The browser runs the page's code with the current user's permissions and can reach the network. REA owns the process and profile until close_browser_session; if the window is closed or the browser exits, browser_session_status reports when.",
    inputSchema: z.strictObject({
      executable_path: localPathStringSchema.describe(
        "Absolute path to a Chromium or Chrome executable.",
      ),
      start_url: httpUrl.describe("http or https URL the first page opens."),
      headless: z
        .boolean()
        .default(false)
        .describe("Run without a window; defaults to false."),
    }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      cdp_endpoint: z.string(),
      started_at: z.string(),
      headless: z.boolean(),
      start_navigation: z.discriminatedUnion("status", [
        z.strictObject({ status: z.literal("committed") }),
        z.strictObject({ status: z.literal("failed"), reason: z.string() }),
      ]),
    }),
    examples: [
      {
        title: "Open a local app in an observable browser",
        input: {
          executable_path: "/usr/bin/chromium-browser",
          start_url: "http://127.0.0.1:8080/",
        },
      },
    ],
  },
  {
    name: "browser_session_status",
    ...toolContractMetadata("browser_session_status"),
    kind: "browser-provider",
    description:
      "Report one REA browser session: whether its browser is still open, its cdp_endpoint, when it ended if the window was closed or the browser exited, and the page and worker targets its DevTools endpoint lists (target_id, type, url, title) for the CDP observation tools.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      session_id: sessionId,
      state: z.enum(["ready", "closed", "cleanup_failed"]),
      cdp_endpoint: z.string(),
      started_at: z.string(),
      headless: z.boolean(),
      ended_at: z.string().nullable(),
      targets: z.array(target),
      targets_status: z.enum(["listed", "unavailable", "not_running"]),
      targets_unavailable_reason: z.string().nullable(),
    }),
    examples: [
      {
        title: "Check a browser session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
  {
    name: "close_browser_session",
    ...toolContractMetadata("close_browser_session"),
    kind: "browser-provider",
    description:
      "Close an REA browser session's browser and remove its temporary profile. A session whose cleanup fails is kept, reported as cleanup_failed by browser_session_status, and can be closed again.",
    inputSchema: z.strictObject({ session_id: sessionId }),
    outputSchema: z.strictObject({
      browser_closed: z.boolean(),
      profile_removed: z.boolean(),
    }),
    examples: [
      {
        title: "Close a browser session",
        input: { session_id: "00000000-0000-4000-8000-000000000001" },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
