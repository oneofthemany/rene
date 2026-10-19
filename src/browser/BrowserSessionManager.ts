import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext } from "playwright-core";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import type { BrowserObservationOperation } from "../domain/browserObservationErrors.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
  readDevtoolsPort,
} from "./BrowserProcessStartup.js";
import { allowedBrowserEnvironment } from "./PlaywrightScenarioBrowser.js";

/** The part of Playwright's Chromium launcher a browser session uses. */
export interface BrowserSessionLauncher {
  launchPersistentContext(
    userDataDir: string,
    options: Parameters<
      (typeof import("playwright-core"))["chromium"]["launchPersistentContext"]
    >[1],
  ): Promise<Pick<BrowserContext, "pages" | "newPage" | "close" | "on">>;
}

export interface BrowserSessionStart {
  readonly executablePath: string;
  readonly startUrl: string;
  readonly headless: boolean;
}

/** How the session's first page reached the start URL. */
export type StartNavigation =
  | { readonly status: "committed" }
  | { readonly status: "failed"; readonly reason: string };

export type BrowserSessionStarted = {
  readonly session_id: string;
  readonly cdp_endpoint: string;
  readonly started_at: string;
  readonly headless: boolean;
  readonly start_navigation: StartNavigation;
};

export type BrowserSessionTarget = {
  readonly target_id: string;
  readonly type: string;
  readonly url: string;
  readonly title: string;
};

export type BrowserSessionStatus = {
  readonly session_id: string;
  readonly state: "ready" | "closed" | "cleanup_failed";
  readonly cdp_endpoint: string;
  readonly started_at: string;
  readonly headless: boolean;
  /** When and how a browser REA didn't close went away (window closed, crash). */
  readonly ended_at: string | null;
  readonly targets: BrowserSessionTarget[];
  readonly targets_status: "listed" | "unavailable" | "not_running";
  readonly targets_unavailable_reason: string | null;
};

export type BrowserSessionClosed = {
  readonly browser_closed: boolean;
  readonly profile_removed: boolean;
};

interface OwnedSession {
  readonly id: string;
  readonly context: Pick<BrowserContext, "pages" | "newPage" | "close" | "on">;
  readonly profilePath: string;
  readonly endpoint: string;
  readonly startedAt: string;
  readonly headless: boolean;
  state: "ready" | "closed" | "cleanup_failed";
  endedAt: string | null;
  browserClosed: boolean;
}

const START: BrowserObservationOperation = "start_browser_session";
const CLOSE: BrowserObservationOperation = "close_browser_session";
const STATUS: BrowserObservationOperation = "browser_session_status";
const TARGET_LIST_TIMEOUT_MS = 5_000;
const START_NAVIGATION_TIMEOUT_MS = 30_000;
const PORT_POLL_MS = 50;

const describe = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Owns browsers REA starts for observation. Each session is a Chromium with
 * a private temporary profile and a loopback DevTools port, so the existing
 * CDP tools (list_browser_targets, observe_web_session, inspect_web_page, ...)
 * can attach to it while the user operates the window. REA owns the process
 * and the profile until close_browser_session confirms both are gone; a
 * session whose cleanup failed is kept so close can be retried.
 */
export class BrowserSessionManager {
  readonly #sessions = new Map<string, OwnedSession>();
  readonly #environment: Readonly<Record<string, string | undefined>>;
  readonly #launcher: () => Promise<BrowserSessionLauncher>;

  constructor(options: {
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly launcher?: () => Promise<BrowserSessionLauncher>;
  }) {
    this.#environment = options.environment;
    // Playwright loads only when a session starts; MCP startup stays off it.
    this.#launcher =
      options.launcher ??
      (async () => (await import("playwright-core")).chromium);
  }

  async start(
    input: BrowserSessionStart,
    signal?: AbortSignal,
  ): Promise<Result<BrowserSessionStarted, BrowserObservationError>> {
    const display = displayArgs(this.#environment);
    if (!input.headless && display === undefined)
      return err(
        new BrowserObservationError(START, "protocol_error", {
          detail:
            "start_browser_session needs a display for a browser window, and REA's environment has neither WAYLAND_DISPLAY nor DISPLAY. Give REA a display, or set headless: true.",
        }),
      );
    const profilePath = await mkdtemp(join(tmpdir(), "rea-browser-session-"));
    let context: OwnedSession["context"] | undefined;
    try {
      await chmod(profilePath, 0o700);
      const launcher = await this.#launcher();
      context = await launcher.launchPersistentContext(profilePath, {
        executablePath: resolve(input.executablePath),
        headless: input.headless,
        // The window's own size, so the person using it sees a normal browser.
        viewport: null,
        acceptDownloads: false,
        env: allowedBrowserEnvironment(this.#environment),
        handleSIGHUP: false,
        handleSIGINT: false,
        handleSIGTERM: false,
        timeout: BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS,
        args: [
          // Port 0: Chrome picks a free loopback port and writes it to
          // DevToolsActivePort in the profile.
          "--remote-debugging-port=0",
          ...(input.headless ? [] : (display ?? [])),
          "--no-first-run",
          "--no-default-browser-check",
        ],
      });
      const port = await waitForPort(profilePath, signal);
      const endpoint = `http://127.0.0.1:${String(port)}`;
      const session: OwnedSession = {
        id: randomUUID(),
        context,
        profilePath,
        endpoint,
        startedAt: new Date().toISOString(),
        headless: input.headless,
        state: "ready",
        endedAt: null,
        browserClosed: false,
      };
      context.on("close", () => {
        session.browserClosed = true;
        if (session.state === "ready") {
          session.state = "closed";
          session.endedAt = new Date().toISOString();
        }
      });
      this.#sessions.set(session.id, session);
      return ok({
        session_id: session.id,
        cdp_endpoint: endpoint,
        started_at: session.startedAt,
        headless: input.headless,
        start_navigation: await navigate(context, input.startUrl),
      });
    } catch (cause: unknown) {
      const cleanup = await removeUnregistered(context, profilePath);
      return err(
        new BrowserObservationError(
          START,
          signal?.aborted === true ? "cancelled" : "protocol_error",
          {
            cause,
            detail: `start_browser_session could not start the browser: ${describe(cause)}${cleanup === undefined ? "" : ` Cleanup also failed: ${cleanup}`}`,
          },
        ),
      );
    }
  }

  async status(
    sessionId: string,
  ): Promise<Result<BrowserSessionStatus, AnalysisInputError>> {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return err(unknownSession(STATUS));
    const base = {
      session_id: session.id,
      state: session.state,
      cdp_endpoint: session.endpoint,
      started_at: session.startedAt,
      headless: session.headless,
      ended_at: session.endedAt,
    };
    if (session.state !== "ready")
      return ok({
        ...base,
        targets: [],
        targets_status: "not_running",
        targets_unavailable_reason: null,
      });
    try {
      return ok({
        ...base,
        targets: await listTargets(session.endpoint),
        targets_status: "listed",
        targets_unavailable_reason: null,
      });
    } catch (cause: unknown) {
      return ok({
        ...base,
        targets: [],
        targets_status: "unavailable",
        targets_unavailable_reason: describe(cause),
      });
    }
  }

  async close(
    sessionId: string,
  ): Promise<
    Result<BrowserSessionClosed, AnalysisInputError | BrowserObservationError>
  > {
    const session = this.#sessions.get(sessionId);
    if (session === undefined) return err(unknownSession(CLOSE));
    const failures: string[] = [];
    if (!session.browserClosed) {
      try {
        await session.context.close();
        session.browserClosed = true;
      } catch (cause: unknown) {
        failures.push(`browser: ${describe(cause)}`);
      }
    }
    let profileRemoved = false;
    if (session.browserClosed) {
      try {
        await rm(session.profilePath, {
          recursive: true,
          force: true,
          maxRetries: 3,
        });
        profileRemoved = true;
      } catch (cause: unknown) {
        failures.push(`profile: ${describe(cause)}`);
      }
    }
    if (failures.length > 0) {
      // Still ours: close can be retried, and status says why it's kept.
      session.state = "cleanup_failed";
      return err(
        new BrowserObservationError(CLOSE, "cleanup_failed", {
          detail: `close_browser_session kept session ${session.id} because cleanup failed (${failures.join("; ")}). Retry close_browser_session.`,
        }),
      );
    }
    this.#sessions.delete(session.id);
    return ok({ browser_closed: true, profile_removed: profileRemoved });
  }

  /** Closes every session; used when the MCP server stops. */
  async closeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#sessions.keys()].map((id) => this.close(id)),
    );
  }
}

/**
 * The display a window uses: Wayland when REA has a Wayland socket, X11 when
 * it has DISPLAY, none otherwise. Chromium's own "auto" choice also needs
 * XDG_SESSION_TYPE, which a container rarely has, so the platform is named.
 */
const displayArgs = (
  environment: Readonly<Record<string, string | undefined>>,
): string[] | undefined => {
  if (environment.WAYLAND_DISPLAY) return ["--ozone-platform=wayland"];
  if (environment.DISPLAY) return ["--ozone-platform=x11"];
  return undefined;
};

const unknownSession = (operation: string): AnalysisInputError =>
  new AnalysisInputError(operation, {
    userMessage: `${operation} needs a session_id returned by start_browser_session in this REA server; closed sessions are forgotten.`,
  });

/** Waits for Chrome to publish its DevTools port in the profile. */
const waitForPort = async (
  profilePath: string,
  signal: AbortSignal | undefined,
): Promise<number> => {
  const file = join(profilePath, "DevToolsActivePort");
  const deadline = performance.now() + BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS;
  for (;;) {
    if (signal?.aborted === true) throw new Error("cancelled");
    const port = await readDevtoolsPort(file);
    if (port !== null) return port;
    if (performance.now() > deadline)
      throw new Error(
        `Chrome didn't publish a DevTools port within ${String(BROWSER_DEVTOOLS_STARTUP_TIMEOUT_MS)} ms.`,
      );
    await new Promise((done) => setTimeout(done, PORT_POLL_MS));
  }
};

/** Opens the start URL in the first page; a failed load leaves the session usable. */
const navigate = async (
  context: OwnedSession["context"],
  url: string,
): Promise<StartNavigation> => {
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(url, {
      waitUntil: "commit",
      timeout: START_NAVIGATION_TIMEOUT_MS,
    });
    return { status: "committed" };
  } catch (cause: unknown) {
    return { status: "failed", reason: describe(cause) };
  }
};

/** Page and worker targets the browser's DevTools endpoint lists. */
const listTargets = async (
  endpoint: string,
): Promise<BrowserSessionTarget[]> => {
  const response = await fetch(`${endpoint}/json/list`, {
    signal: AbortSignal.timeout(TARGET_LIST_TIMEOUT_MS),
  });
  if (!response.ok)
    throw new Error(
      `the DevTools endpoint answered ${String(response.status)}`,
    );
  const listed: unknown = await response.json();
  if (!Array.isArray(listed))
    throw new Error(
      "the DevTools endpoint returned something other than a list",
    );
  return listed.flatMap((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return [];
    const { id, type, url, title } = entry as Record<string, unknown>;
    return typeof id === "string" && typeof type === "string"
      ? [
          {
            target_id: id,
            type,
            url: typeof url === "string" ? url : "",
            title: typeof title === "string" ? title : "",
          },
        ]
      : [];
  });
};

/** Removes a browser and profile that never became a session; returns why not. */
const removeUnregistered = async (
  context: OwnedSession["context"] | undefined,
  profilePath: string,
): Promise<string | undefined> => {
  const failures: string[] = [];
  if (context !== undefined)
    await context
      .close()
      .catch((cause: unknown) => failures.push(`browser: ${describe(cause)}`));
  if (failures.length === 0)
    await rm(profilePath, {
      recursive: true,
      force: true,
      maxRetries: 3,
    }).catch((cause: unknown) => failures.push(`profile: ${describe(cause)}`));
  return failures.length === 0 ? undefined : failures.join("; ");
};
