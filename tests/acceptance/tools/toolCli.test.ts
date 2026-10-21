import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const execute = promisify(execFile);
const REA = resolve("scripts/rea.mjs");

const rea = async (
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await execute(process.execPath, [REA, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (cause: unknown) {
    const failure = cause as {
      code?: number;
      stdout?: string;
      stderr?: string;
    };
    return {
      code: failure.code ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
};

const waitFor = async (condition: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((settle) => setTimeout(settle, 50));
  }
};

const UNKNOWN = {
  question: "Does the daemon keep state between calls?",
  severity: "low",
  domain: "tool-cli",
  required_authority: null,
  required_confidence: "observed",
  required_environment: null,
  recommended_probes: [],
  relationships: [],
};

describe("explicit tool CLI", () => {
  it("lists, describes and calls tools in-process", async () => {
    const root = await createTestTempDirectory("rea-tool-cli-");
    const file = join(root, "note.txt");
    await writeFile(file, "hello\n");
    const env = { REA_TOOLBOX_ROOTS: root };

    const listed = await rea(["tools", "search", "read", "text", "file"], env);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toMatch(/^read_file\t\S/mu);

    const described = await rea(["tools", "describe", "read_file"], env);
    expect(described.code).toBe(0);
    const tool = JSON.parse(described.stdout) as {
      name: string;
      input_schema: { required?: string[] };
    };
    expect(tool.name).toBe("read_file");
    expect(tool.input_schema.required).toContain("path");

    const called = await rea(
      ["call", "read_file", JSON.stringify({ path: file })],
      env,
    );
    expect(called.code).toBe(0);
    // Info logs stay off the agent's context unless asked for.
    expect(called.stderr).toBe("");
    const evidence = JSON.parse(called.stdout) as {
      operation: string;
      normalized_result: { text: string };
    };
    expect(evidence.operation).toBe("read_file");
    expect(evidence.normalized_result.text).toBe("hello\n");

    expect((await rea(["call", "read_file", "not json"], env)).code).toBe(2);
    expect((await rea(["call", "no_such_tool", "{}"], env)).code).toBe(1);
    expect((await rea(["tools", "describe", "no_such_tool"], env)).code).toBe(
      1,
    );
  }, 120_000);

  it("keeps one session across calls through a daemon and cleans up its socket", async () => {
    const root = await createTestTempDirectory("rea-tool-daemon-");
    const socket = join(root, "rea.sock");
    const daemon = spawn(
      process.execPath,
      [REA, "daemon", "--socket", socket],
      {
        env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const exited = new Promise<number | null>((settle) =>
      daemon.once("exit", (code) => settle(code)),
    );
    try {
      await waitFor(() => existsSync(socket), 60_000);
      expect((await stat(socket)).mode & 0o777).toBe(0o600);
      const env = { REA_DAEMON_SOCKET: socket };

      const recorded = await rea(
        ["call", "record_unknown", JSON.stringify(UNKNOWN)],
        env,
      );
      expect(recorded.code).toBe(0);
      const listed = await rea(["call", "list_unknowns", "{}"], env);
      expect(listed.code).toBe(0);
      const page = JSON.parse(listed.stdout) as {
        result: { total: number; items: { question: string }[] };
      };
      expect(page.result.total).toBe(1);
      expect(page.result.items[0]?.question).toBe(UNKNOWN.question);

      // A second daemon on a live socket is refused, not silently replaced.
      expect((await rea(["daemon", "--socket", socket], {})).code).toBe(1);
    } finally {
      daemon.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
    expect(existsSync(socket)).toBe(false);

    const absent = await rea(["call", "list_unknowns", "{}"], {
      REA_DAEMON_SOCKET: socket,
    });
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("No REA daemon answers");
  }, 180_000);
});
