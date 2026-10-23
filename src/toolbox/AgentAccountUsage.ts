import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  claudeProjects,
  claudeUsage,
  copilotEvents,
  copilotSessions,
  type ConversationEvent,
} from "./AgentConversations.js";

/**
 * Account usage of the agents on this machine: the plan limits each
 * account's service last reported (Claude Code's session and weekly windows,
 * Copilot CLI's monthly premium requests), and the tokens and requests this
 * machine's transcripts show were used, for any window.
 *
 * The limits are the services' own figures, as of when the agent last
 * fetched them: they count use on every device and app, which the local
 * transcripts can't see. The local figures count only this machine.
 */

type Environment = Readonly<Record<string, string | undefined>>;
type Raw = Record<string, unknown>;
const record = (value: unknown): Raw =>
  typeof value === "object" && value !== null ? (value as Raw) : {};
const numberOrNull = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown) =>
  typeof value === "string" && value !== "" ? value : null;

/** One of the plan's usage windows, as the service reported it. */
export interface PlanWindow {
  /** The service's name for it, such as "session" or "weekly_all". */
  readonly kind: string;
  /** "session" (a few hours), "weekly" and so on. */
  readonly group: string;
  readonly percent: number;
  readonly resets_at: string | null;
  /** Whether this window is the one that limits use now. */
  readonly active: boolean;
  readonly severity: string | null;
}

export interface ClaudePlan {
  /** When Claude Code fetched these figures. */
  readonly fetched_at: string;
  readonly windows: readonly PlanWindow[];
  /** Paid use past the plan's limits, per month. */
  readonly extra_usage: {
    readonly enabled: boolean;
    readonly used: number;
    readonly limit: number | null;
    readonly currency: string | null;
    readonly disabled_reason: string | null;
  } | null;
  /** Claude Code's share of the weekly window's use, in percent. */
  readonly claude_code_share: number | null;
  /**
   * Limit resets the account was granted, when Claude Code cached them;
   * null when it didn't (it asks only at a limit or for /limit-reset).
   */
  readonly resets: readonly LimitReset[] | null;
}

/** A grant of limit resets: which limit it clears, how many are left, until when. */
export interface LimitReset {
  readonly label: string;
  /** "session", "weekly" or "full". */
  readonly type: string | null;
  readonly left: number;
  readonly total: number | null;
  readonly usable_now: boolean;
  readonly paused: boolean;
  readonly starts_at: string | null;
  readonly ends_at: string | null;
}

const resetOf = (value: unknown): LimitReset[] => {
  const grant = record(value);
  const left = numberOrNull(grant.resets_left);
  return left === null
    ? []
    : [
        {
          label: textOrNull(grant.label) ?? "Limit reset",
          type: textOrNull(grant.type),
          left,
          total: numberOrNull(grant.resets_total),
          usable_now: grant.usable_now === true,
          paused: grant.paused === true,
          starts_at: textOrNull(grant.starts_at),
          ends_at: textOrNull(grant.ends_at),
        },
      ];
};

/** The grants in Claude Code's reset status: a list, or one under `grants`. */
const resetsFrom = (status: unknown): LimitReset[] | null => {
  if (status === null || status === undefined) return null;
  const list = Array.isArray(status) ? status : record(status).grants;
  return Array.isArray(list) ? list.flatMap(resetOf) : null;
};

const claudeState = (env: Environment) =>
  env.CLAUDE_CONFIG_DIR
    ? join(env.CLAUDE_CONFIG_DIR, ".claude.json")
    : join(homedir(), ".claude.json");

const minor = (amount: unknown, decimals: unknown) => {
  const value = numberOrNull(amount);
  const places = numberOrNull(decimals) ?? 0;
  return value === null ? null : value / 10 ** places;
};

/** The plan limits Claude Code last fetched, or null when it has none cached. */
export function claudePlanFrom(state: unknown): ClaudePlan | null {
  const cached = record(record(state).cachedUsageUtilization);
  const fetched = numberOrNull(cached.fetchedAtMs);
  const utilization = record(cached.utilization);
  if (fetched === null || !Array.isArray(utilization.limits)) return null;
  const windows = utilization.limits.map(record).flatMap((limit) => {
    const percent = numberOrNull(limit.percent);
    const kind = textOrNull(limit.kind);
    return percent === null || kind === null
      ? []
      : [
          {
            kind,
            group: textOrNull(limit.group) ?? kind,
            percent,
            resets_at: textOrNull(limit.resets_at),
            active: limit.is_active === true,
            severity: textOrNull(limit.severity),
          },
        ];
  });
  const extra = record(utilization.extra_usage);
  const share = (
    Array.isArray(record(utilization.seven_day_breakdown).rows)
      ? (record(utilization.seven_day_breakdown).rows as unknown[])
      : []
  )
    .map(record)
    .find((row) => row.key === "claude_code");
  return {
    fetched_at: new Date(fetched).toISOString(),
    windows,
    extra_usage:
      Object.keys(extra).length === 0
        ? null
        : {
            enabled: extra.is_enabled === true,
            used: minor(extra.used_credits, extra.decimal_places) ?? 0,
            limit: minor(extra.monthly_limit, extra.decimal_places),
            currency: textOrNull(extra.currency),
            disabled_reason: textOrNull(extra.disabled_reason),
          },
    claude_code_share: numberOrNull(share?.percent),
    resets: resetsFrom(utilization.cedar_ember),
  };
}

let planCache: { mtimeMs: number; plan: ClaudePlan | null } | undefined;

/** Claude Code's cached plan limits, read again when its state file changes. */
export async function readClaudePlan(
  env: Environment,
): Promise<ClaudePlan | null> {
  const path = claudeState(env);
  const info = await stat(path).catch(() => undefined);
  if (!info) return null;
  if (planCache?.mtimeMs === info.mtimeMs) return planCache.plan;
  const plan = claudePlanFrom(
    JSON.parse(await readFile(path, "utf8").catch(() => "{}")),
  );
  planCache = { mtimeMs: info.mtimeMs, plan };
  return plan;
}

export type QuotaEvent = Extract<ConversationEvent, { kind: "quota" }>;

export interface UsageTotals {
  calls: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  premium_requests: number;
}
const emptyTotals = (): UsageTotals => ({
  calls: 0,
  input: 0,
  cache_read: 0,
  cache_write: 0,
  output: 0,
  premium_requests: 0,
});

interface Entry {
  readonly at: number;
  readonly calls: number;
  readonly input: number;
  readonly cache_read: number;
  readonly cache_write: number;
  readonly output: number;
  readonly premium_requests: number;
}
interface FileState {
  offset: number;
  mtimeMs: number;
  /** Claude Code repeats a call's usage on each of its records: one per call. */
  calls: Map<string, Entry>;
  /** Models some call of was counted above, so a session total would repeat it. */
  callModels: Set<string>;
  /** Session totals, counted only for a model whose calls weren't recorded. */
  sessions: Map<string, Entry>;
  premium: Entry[];
  lastPremium: number;
  quota?: QuotaEvent;
}

export type LedgerAgent = "claude-code" | "copilot-cli";
const READ_SLICE = 8 * 1024 * 1024;
// Lines worth parsing: the rest of a transcript carries no usage.
const WORTH: Readonly<Record<LedgerAgent, RegExp>> = {
  "claude-code": /"usage"/u,
  "copilot-cli":
    /"(model\.model_call_success|session\.usage_record|session\.shutdown|session\.usage_checkpoint)"/u,
};

async function claudeTranscripts(directory: string): Promise<string[]> {
  const found: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await claudeTranscripts(path)));
    else if (entry.name.endsWith(".jsonl")) found.push(path);
  }
  return found;
}

async function copilotTranscripts(directory: string): Promise<string[]> {
  const sessions = await readdir(directory).catch(() => [] as string[]);
  return sessions.map((session) => join(directory, session, "events.jsonl"));
}

const entryOf = (event: ConversationEvent): Entry | undefined => {
  const at = Date.parse(event.at ?? "");
  if (!Number.isFinite(at)) return undefined;
  if (event.kind === "usage")
    return {
      at,
      calls: event.scope === "call" ? 1 : 0,
      input: event.input,
      cache_read: event.cache_read,
      cache_write: event.cache_write,
      output: event.output,
      premium_requests: 0,
    };
  return undefined;
};

/** Adds one transcript line's usage to its file's state. */
function take(agent: LedgerAgent, state: FileState, value: unknown) {
  const events =
    agent === "claude-code" ? claudeUsage(value) : copilotEvents(value);
  for (const event of events) {
    const at = Date.parse(event.at ?? "");
    if (event.kind === "quota") state.quota = event;
    else if (event.kind === "billing" && Number.isFinite(at)) {
      // Copilot reports the session's running total: use is what it gained.
      const gained = Math.max(0, event.premium_requests - state.lastPremium);
      state.lastPremium = Math.max(state.lastPremium, event.premium_requests);
      if (gained > 0)
        state.premium.push({ ...emptyTotals(), at, premium_requests: gained });
    } else if (event.kind === "usage") {
      const entry = entryOf(event);
      if (!entry) continue;
      if (event.scope === "session")
        state.sessions.set(event.model ?? "", entry);
      else {
        state.calls.set(event.call ?? `${state.calls.size}`, entry);
        state.callModels.add(event.model ?? "");
      }
    }
  }
}

/** Reads what a transcript gained since its offset; whole lines only. */
async function follow(agent: LedgerAgent, path: string, state: FileState) {
  const handle = await open(path, "r").catch(() => undefined);
  if (!handle) return;
  try {
    const { size } = await handle.stat();
    if (size < state.offset) Object.assign(state, freshState(), { offset: 0 });
    while (state.offset < size) {
      const length = Math.min(READ_SLICE, size - state.offset);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      const end = buffer.lastIndexOf(0x0a);
      if (end === -1) break;
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        if (!WORTH[agent].test(line)) continue;
        try {
          take(agent, state, JSON.parse(line));
        } catch {
          // A line that isn't JSON carries nothing to count.
        }
      }
      state.offset += end + 1;
    }
  } finally {
    await handle.close();
  }
}

const freshState = (): FileState => ({
  offset: 0,
  mtimeMs: 0,
  calls: new Map(),
  callModels: new Set(),
  sessions: new Map(),
  premium: [],
  lastPremium: 0,
});

/**
 * Follows every Claude Code and Copilot CLI transcript on this machine
 * changed within `horizonMs`, by offset, so each refresh reads only what was
 * added. Totals cover any window inside the horizon.
 */
export function createUsageLedger(env: Environment, horizonMs: number) {
  const files = new Map<string, { agent: LedgerAgent; state: FileState }>();
  let refreshing: Promise<void> | undefined;

  async function scan(now: number) {
    const sources: [LedgerAgent, string[]][] = [
      ["claude-code", await claudeTranscripts(claudeProjects(env))],
      ["copilot-cli", await copilotTranscripts(copilotSessions(env))],
    ];
    for (const [agent, paths] of sources)
      for (const path of paths) {
        const info = await stat(path).catch(() => undefined);
        if (!info || info.mtimeMs < now - horizonMs) continue;
        const known = files.get(path) ?? { agent, state: freshState() };
        files.set(path, known);
        if (known.state.mtimeMs === info.mtimeMs) continue;
        await follow(agent, path, known.state);
        known.state.mtimeMs = info.mtimeMs;
      }
  }

  return {
    /** Reads what transcripts gained; concurrent callers share one read. */
    refresh(now = Date.now()) {
      refreshing ??= scan(now).finally(() => {
        refreshing = undefined;
      });
      return refreshing;
    },
    /** An agent's use with times in [from, to). */
    totals(agent: LedgerAgent, from: number, to: number): UsageTotals {
      const totals = emptyTotals();
      for (const file of files.values()) {
        if (file.agent !== agent) continue;
        const { state } = file;
        // Calls are preferred: they carry their own times, so they fall in
        // the right window, where a session total lands at the session's end.
        const entries = [
          ...state.calls.values(),
          ...[...state.sessions]
            .filter(([model]) => !state.callModels.has(model))
            .map(([, entry]) => entry),
          ...state.premium,
        ];
        for (const entry of entries) {
          if (entry.at < from || entry.at >= to) continue;
          totals.calls += entry.calls;
          totals.input += entry.input;
          totals.cache_read += entry.cache_read;
          totals.cache_write += entry.cache_write;
          totals.output += entry.output;
          totals.premium_requests += entry.premium_requests;
        }
      }
      return totals;
    },
    /** The newest premium-request quota Copilot CLI reported. */
    copilotQuota(): QuotaEvent | null {
      let newest: QuotaEvent | null = null;
      for (const file of files.values()) {
        const quota = file.state.quota;
        if (quota && (!newest || (quota.at ?? "") > (newest.at ?? "")))
          newest = quota;
      }
      return newest;
    },
  };
}

export type UsageLedger = ReturnType<typeof createUsageLedger>;
