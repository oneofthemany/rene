import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  claudePlanFrom,
  createUsageLedger,
  readClaudePlan,
} from "./AgentAccountUsage.js";

const lines = (records: object[]) =>
  records.map((value) => JSON.stringify(value)).join("\n") + "\n";
const T = (minutes: number) =>
  new Date(Date.parse("2026-10-23T09:00:00Z") + minutes * 60_000).toISOString();
const assistant = (
  minutes: number,
  id: string,
  output: number,
  extra = {},
) => ({
  type: "assistant",
  timestamp: T(minutes),
  ...extra,
  message: {
    id,
    model: "claude-opus-5-5",
    usage: {
      input_tokens: 1,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 10,
      output_tokens: output,
    },
    content: [{ type: "text", text: "x" }],
  },
});

// Claude Code's state file: account details beside the cached plan figures.
const CLAUDE_STATE = {
  oauthAccount: { emailAddress: "not read" },
  cachedUsageUtilization: {
    fetchedAtMs: Date.parse(T(5)),
    accountUuid: "not read",
    utilization: {
      limits: [
        {
          kind: "session",
          group: "session",
          percent: 54,
          resets_at: T(200),
          is_active: true,
          severity: "normal",
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 49,
          resets_at: T(9000),
          is_active: false,
        },
      ],
      extra_usage: {
        is_enabled: false,
        monthly_limit: 8000,
        used_credits: 0,
        decimal_places: 2,
        currency: "GBP",
        disabled_reason: "out_of_credits",
      },
      seven_day_breakdown: {
        rows: [{ key: "claude_code", percent: 97 }],
      },
    },
  },
};

/**
 * A Copilot CLI session that records each call as it makes it, and repeats
 * those calls in its shutdown totals alongside a model that recorded none.
 */
const COPILOT_SESSION = [
  {
    type: "session.usage_record",
    timestamp: T(0),
    data: {
      usage: {
        model: "claude-opus-5",
        inputTokens: 1000,
        outputTokens: 50,
        cacheReadTokens: 800,
        cacheWriteTokens: 150,
        maxPromptTokens: 200000,
        accounting: { usageId: "u1" },
      },
    },
  },
  {
    type: "session.usage_record",
    timestamp: T(30),
    data: {
      usage: {
        model: "claude-opus-5",
        inputTokens: 2000,
        outputTokens: 60,
        cacheReadTokens: 1900,
        cacheWriteTokens: 50,
        maxPromptTokens: 200000,
        accounting: { usageId: "u2" },
      },
    },
  },
  {
    type: "session.shutdown",
    timestamp: T(40),
    data: {
      totalPremiumRequests: 5,
      modelMetrics: {
        "claude-opus-5": {
          usage: {
            inputTokens: 3000,
            outputTokens: 110,
            cacheReadTokens: 2700,
            cacheWriteTokens: 200,
          },
        },
        "gpt-5.4-nano": {
          usage: {
            inputTokens: 600,
            outputTokens: 35,
            cacheReadTokens: 100,
            cacheWriteTokens: 0,
          },
        },
      },
    },
  },
];

describe("account usage", () => {
  let root: string;
  let env: Record<string, string>;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "rene-account-"));
    env = {
      CLAUDE_CONFIG_DIR: join(root, "claude"),
      COPILOT_HOME: join(root, "copilot"),
    };
    const project = join(root, "claude", "projects", "-p");
    await mkdir(join(project, "s1", "subagents"), { recursive: true });
    // Two records of one call repeat its usage; it counts once.
    await writeFile(
      join(project, "s1.jsonl"),
      lines([
        assistant(0, "m1", 40),
        assistant(0, "m1", 40),
        assistant(10, "m2", 5),
        { type: "user", timestamp: T(11), message: { content: "usage" } },
      ]),
    );
    // A subagent's calls count against the account too.
    await writeFile(
      join(project, "s1", "subagents", "agent-a.jsonl"),
      lines([assistant(20, "m3", 7, { isSidechain: true })]),
    );
    const session = join(root, "copilot", "session-state", "c1");
    await mkdir(session, { recursive: true });
    await writeFile(
      join(session, "events.jsonl"),
      lines([
        {
          type: "session.usage_checkpoint",
          timestamp: T(0),
          data: { totalPremiumRequests: 3 },
        },
        {
          type: "session.usage_checkpoint",
          timestamp: T(30),
          data: { totalPremiumRequests: 5 },
        },
        {
          type: "model.model_call_success",
          timestamp: T(31),
          data: {
            quotaSnapshots: {
              premium_interactions: {
                isUnlimitedEntitlement: false,
                entitlementRequests: 1000,
                usedRequests: 170,
                remainingPercentage: 83,
                resetDate: "2026-11-01T00:00:00Z",
                overageAllowedWithExhaustedQuota: true,
              },
            },
          },
        },
        ...COPILOT_SESSION,
      ]),
    );
    await writeFile(
      join(root, "claude", ".claude.json"),
      JSON.stringify(CLAUDE_STATE),
    );
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it("counts each call once, subagents included, and Copilot's premium requests as gained", async () => {
    const now = Date.parse(T(60));
    const ledger = createUsageLedger(env, Number.MAX_SAFE_INTEGER);
    await ledger.refresh(now);
    expect(ledger.totals("claude-code", 0, now)).toEqual({
      calls: 3,
      input: 3,
      cache_read: 300,
      cache_write: 30,
      output: 52,
      premium_requests: 0,
    });
    expect(ledger.totals("claude-code", Date.parse(T(5)), now).output).toBe(12);
    expect(ledger.totals("copilot-cli", 0, now).premium_requests).toBe(5);
    expect(
      ledger.totals("copilot-cli", Date.parse(T(1)), now).premium_requests,
    ).toBe(2);
    expect(ledger.copilotQuota()).toMatchObject({
      entitlement: 1000,
      used: 170,
      remaining_percent: 83,
    });
    // A second read finds nothing new and counts nothing twice.
    await ledger.refresh(now);
    expect(ledger.totals("claude-code", 0, now).calls).toBe(3);
  });

  it("counts Copilot's recorded calls, not the shutdown totals repeating them", async () => {
    const now = Date.parse(T(60));
    const ledger = createUsageLedger(env, Number.MAX_SAFE_INTEGER);
    await ledger.refresh(now);
    // The two calls, plus the shutdown total of the model that recorded
    // none; claude-opus-5's own shutdown total would count them twice.
    expect(ledger.totals("copilot-cli", 0, now)).toEqual({
      calls: 2,
      input: 600,
      cache_read: 2800,
      cache_write: 200,
      output: 145,
      premium_requests: 5,
    });
    // Each call falls in the window it was made in, not at the session's end.
    expect(ledger.totals("copilot-cli", 0, Date.parse(T(1))).output).toBe(50);
  });

  it("reads Claude Code's cached plan windows and extra usage, nothing else of its state", async () => {
    const plan = await readClaudePlan(env);
    expect(plan).toEqual({
      fetched_at: T(5),
      windows: [
        {
          kind: "session",
          group: "session",
          percent: 54,
          resets_at: T(200),
          active: true,
          severity: "normal",
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 49,
          resets_at: T(9000),
          active: false,
          severity: null,
        },
      ],
      extra_usage: {
        enabled: false,
        used: 0,
        limit: 80,
        currency: "GBP",
        disabled_reason: "out_of_credits",
      },
      claude_code_share: 97,
      // Not asked for: unknown, not none.
      resets: null,
    });
  });
});

describe("limit resets", () => {
  it("reads limit reset grants when Claude Code cached them", () => {
    const state = structuredClone(CLAUDE_STATE) as {
      cachedUsageUtilization: { utilization: Record<string, unknown> };
    };
    state.cachedUsageUtilization.utilization.cedar_ember = {
      grants: [
        {
          id: "g1",
          label: "Session limit reset",
          type: "session",
          resets_total: 2,
          resets_left: 1,
          usable_now: true,
          ends_at: "2026-11-05T07:59:00Z",
        },
        { label: "malformed: no count" },
      ],
    };
    expect(claudePlanFrom(state)?.resets).toEqual([
      {
        label: "Session limit reset",
        type: "session",
        left: 1,
        total: 2,
        usable_now: true,
        paused: false,
        starts_at: null,
        ends_at: "2026-11-05T07:59:00Z",
      },
    ]);
  });
});
