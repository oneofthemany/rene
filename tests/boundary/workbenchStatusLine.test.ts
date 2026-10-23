import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

// The status line a workbench Claude Code session runs (frontend/statusLine.mjs):
// it keeps the plan's live limits from its input and nothing else of it, and
// shows the user's own status line when they have one.

const recorder = fileURLToPath(
  new URL("../../frontend/statusLine.mjs", import.meta.url),
);
const input = JSON.stringify({
  session_id: "s1",
  cwd: "/home/someone/project",
  transcript_path: "/home/someone/.claude/projects/p/s1.jsonl",
  rate_limits_available: true,
  rate_limits: {
    five_hour: { used_percentage: 61.4, resets_at: 1792759800 },
    seven_day: { used_percentage: 50, resets_at: 1793199600 },
  },
});

let folder: string;
beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "rene-status-"));
});
afterEach(() => rm(folder, { recursive: true, force: true }));

const run = (env: Record<string, string>) =>
  spawnSync(process.execPath, [recorder], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env },
  });

it("records only the live limits and shows them", async () => {
  const file = join(folder, "claude-status.json");
  const result = run({ REA_STATUS_FILE: file });
  expect(result.stdout).toBe("5h 61% · 7d 50%");
  const recorded = JSON.parse(await readFile(file, "utf8")) as Record<
    string,
    unknown
  >;
  expect(Object.keys(recorded).sort()).toEqual([
    "at",
    "available",
    "rate_limits",
    "session",
  ]);
  expect(recorded).toMatchObject({
    session: "s1",
    available: true,
    rate_limits: { five_hour: { used_percentage: 61.4 } },
  });
});

it("shows the user's own status line on the same input", () => {
  const result = run({
    REA_STATUS_FILE: join(folder, "claude-status.json"),
    REA_USER_STATUSLINE: "wc -c | tr -d ' '",
  });
  expect(result.stdout.trim()).toBe(String(Buffer.byteLength(input)));
});
