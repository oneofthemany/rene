import { readFileSync } from "node:fs";

/**
 * Reports of tool calls to the rene workbench bridge, which records them in
 * the project's history. Both ways an agent reaches rene report through
 * here: the MCP relay (frontend/relay.mjs), which reads calls off the stdio
 * traffic, and `rene call`, which makes them itself.
 *
 * The bridge writes a private report file per agent session holding its URL
 * and the session's token, and names it to the relay with --report and to
 * the agent's shell with REA_HISTORY_REPORT. Reporting never changes or
 * delays a call: a missing file or a bridge that is down costs one line on
 * stderr, and the call carries on.
 */

/** Results larger than this are reported by size only; history keeps up to 8 MiB. */
export const MAX_REPORTED_RESULT_BYTES = 8 * 1024 * 1024;

/** How long a finishing caller waits for outstanding reports to land. */
export const REPORT_DRAIN_MS = 2000;

const REPORT_TIMEOUT_MS = 10_000;

export interface ReportTarget {
  readonly url: string;
  readonly token: string;
}

export type ReportEvent =
  | {
      readonly type: "started";
      readonly ref: string;
      readonly name: string;
      readonly args: unknown;
      readonly startedAt: number;
    }
  | ({
      readonly type: "settled";
      readonly ref: string;
      readonly outcome: "ok" | "error";
      readonly elapsedMs: number;
      readonly cancelled?: boolean;
      readonly failure?: string;
      readonly code?: unknown;
    } & ResultFields);

type ResultFields =
  | { readonly result?: unknown; readonly resultOmitted?: undefined }
  | {
      readonly result?: undefined;
      readonly resultOmitted: true;
      readonly resultBytes: number;
      readonly untrusted: boolean;
    };

export type ReportTargetRead =
  | { readonly ok: true; readonly target: ReportTarget }
  | { readonly ok: false; readonly reason: string };

/** Read the bridge's report file: its URL and this session's token. */
export const readReportTarget = (path: string): ReportTargetRead => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause: unknown) {
    return {
      ok: false,
      reason: `can't read ${path} (${cause instanceof Error ? cause.message : String(cause)})`,
    };
  }
  const value = parsed as { url?: unknown; token?: unknown } | null;
  if (typeof value?.url !== "string" || typeof value.token !== "string")
    return { ok: false, reason: `${path} holds no report URL and token` };
  return { ok: true, target: { url: value.url, token: value.token } };
};

export interface ReportSender {
  /** Queue one report; reports go out in order, so "started" precedes "settled". */
  send(event: ReportEvent): void;
  /** Resolve once queued reports have landed or `ms` has passed. */
  drain(ms?: number): Promise<void>;
}

/** Send reports to the bridge one at a time, warning once if they fail. */
export const createReportSender = (
  target: ReportTarget,
  writeStderr: (text: string) => void,
  label: string,
): ReportSender => {
  let queue = Promise.resolve();
  let warned = false;
  return {
    send(event) {
      queue = queue.then(async () => {
        try {
          const response = await fetch(target.url, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-rea-relay-token": target.token,
            },
            body: JSON.stringify(event),
            signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
          });
          if (!response.ok)
            throw new Error(`the bridge answered ${response.status}`);
        } catch (cause: unknown) {
          if (!warned)
            writeStderr(
              `${label}: couldn't record a call in the workbench (${cause instanceof Error ? cause.message : String(cause)}); the call is unaffected.\n`,
            );
          warned = true;
        }
      });
    },
    drain(ms = REPORT_DRAIN_MS) {
      return Promise.race([
        queue,
        new Promise<void>((resolve) => setTimeout(resolve, ms).unref()),
      ]);
    },
  };
};

/** A tool result as history keeps it: inline up to the cap, else its size. */
export const resultFields = (result: unknown): ResultFields => {
  const bytes = Buffer.byteLength(JSON.stringify(result ?? null));
  if (bytes <= MAX_REPORTED_RESULT_BYTES) return { result };
  const meta = (
    result as {
      _meta?: { provenance?: { untrusted_content?: unknown } };
    } | null
  )?._meta;
  return {
    resultOmitted: true,
    resultBytes: bytes,
    untrusted: meta?.provenance?.untrusted_content === true,
  };
};
