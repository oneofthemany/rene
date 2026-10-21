import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// `rene skill`: the reverse-engineer-anything skill for this machine's
// agents, installed without `rea setup` (which registered REA over MCP).

const execute = promisify(execFile);
const RENE = resolve("scripts/rene.mjs");

const rene = (home: string, ...args: string[]) =>
  execute(process.execPath, [RENE, "skill", ...args], {
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      REA_LOG_LEVEL: "silent",
    },
  }).then(
    ({ stdout }) => ({ code: 0, stdout, stderr: "" }),
    (cause: { code?: number; stdout?: string; stderr?: string }) => ({
      code: cause.code ?? -1,
      stdout: cause.stdout ?? "",
      stderr: cause.stderr ?? "",
    }),
  );

it("installs the skill where agents read it, and reports it current", async () => {
  const home = await createTestTempDirectory("rene-skill-");
  const before = await rene(home, "status");
  expect(before.code).toBe(0);
  expect(JSON.parse(before.stdout)).toMatchObject({ installed: false });

  const installed = await rene(home, "install", "--client", "claude_code");
  expect(installed.code).toBe(0);
  const report = JSON.parse(installed.stdout) as {
    result: string;
    current: boolean;
    destinations: { client: string; path: string }[];
  };
  expect(report).toMatchObject({ result: "installed", current: true });
  expect(report.destinations.map(({ client }) => client).sort()).toEqual([
    "claude_code",
    "shared",
  ]);
  const skill = await readFile(
    join(home, ".claude", "skills", "reverse-engineer-anything", "SKILL.md"),
    "utf8",
  );
  expect(skill).toMatch(/^---\nname: reverse-engineer-anything\n/u);

  // Again: the folders that have it are kept current, nothing changes.
  const again = await rene(home, "install");
  expect(JSON.parse(again.stdout)).toMatchObject({
    result: "unchanged",
    current: true,
  });
});

it("refuses an agent it knows no skill folder for", async () => {
  const home = await createTestTempDirectory("rene-skill-unknown-");
  const refused = await rene(home, "install", "--client", "nope");
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain("no skill folder is known for nope");
  expect((await rene(home, "status", "--client", "x")).code).toBe(2);
});
