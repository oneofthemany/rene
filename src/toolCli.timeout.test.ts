import { expect, it } from "vitest";

import { callTimeoutMs } from "./toolCli.js";

// rene call waits as long as the tool's own deadline, and no longer: the
// MCP SDK's 60 s default abandoned longer runs (a test suite through
// run_command), and an open-ended wait would leave a stuck call hanging.
it("waits for the deadline a call names, with a margin to report", () => {
  expect(callTimeoutMs({ command: "npm test", timeout_ms: 600_000 })).toBe(
    630_000,
  );
  expect(callTimeoutMs({ analysis_timeout_ms: 120_000 })).toBe(150_000);
});

it("falls back to the deadline default the tool's schema declares", () => {
  // run_command's schema declares timeout_ms: 120000.
  expect(callTimeoutMs({ command: "ls" }, { timeout_ms: 120_000 })).toBe(
    150_000,
  );
  // The call's own value wins over the default.
  expect(callTimeoutMs({ timeout_ms: 5_000 }, { timeout_ms: 120_000 })).toBe(
    35_000,
  );
});

it("waits two minutes for a tool that declares no deadline", () => {
  expect(callTimeoutMs({ path: "/x" })).toBe(120_000);
  // Not a usable deadline: the two-minute default.
  for (const timeout_ms of [0, -5, Number.NaN, "60000"])
    expect(callTimeoutMs({ timeout_ms }, { timeout_ms: undefined })).toBe(
      120_000,
    );
});
