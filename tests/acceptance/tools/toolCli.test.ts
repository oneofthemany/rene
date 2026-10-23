import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile, stat, writeFile } from "node:fs/promises";
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
    // The fields that only repeat the call, and empty ones, are left out
    // unless --full asks for the whole envelope.
    expect(evidence).not.toHaveProperty("parameters");
    expect(evidence).not.toHaveProperty("provider");
    expect(evidence).not.toHaveProperty("raw_result");
    expect(evidence).toHaveProperty("limitations");
    const whole = await rea(
      ["call", "read_file", JSON.stringify({ path: file }), "--full"],
      env,
    );
    expect(whole.code).toBe(0);
    const envelope = JSON.parse(whole.stdout) as Record<string, unknown>;
    expect(envelope.parameters).toMatchObject({ path: file });
    expect(envelope).toHaveProperty("provider");
    expect(envelope.raw_result).toBeNull();
    expect(whole.stdout.length).toBeGreaterThan(called.stdout.length);

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

it("records a call in the workbench history through the session's report file", async () => {
  const root = await createTestTempDirectory("rea-tool-history-");
  const file = join(root, "note.txt");
  await writeFile(file, "hello\n");
  const reports: { token: unknown; event: Record<string, unknown> }[] = [];
  // Stands in for the workbench bridge's /api/relay endpoint.
  const bridge = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      reports.push({
        token: request.headers["x-rea-relay-token"],
        event: JSON.parse(body) as Record<string, unknown>,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  await new Promise<void>((listening) =>
    bridge.listen(0, "127.0.0.1", listening),
  );
  try {
    const { port } = bridge.address() as AddressInfo;
    const report = join(root, "relay-report.json");
    await writeFile(
      report,
      JSON.stringify({
        url: `http://127.0.0.1:${port}/api/relay`,
        token: "t1",
      }),
      { mode: 0o600 },
    );
    const env = { REA_TOOLBOX_ROOTS: root, REA_HISTORY_REPORT: report };
    const args = { path: file };

    const called = await rea(["call", "read_file", JSON.stringify(args)], env);
    expect(called.code).toBe(0);
    expect(called.stderr).toBe("");
    const failed = await rea(["call", "no_such_tool", "{}"], env);
    expect(failed.code).toBe(1);

    expect(reports.every(({ token }) => token === "t1")).toBe(true);
    const events = reports.map(({ event }) => event);
    expect(
      events.map(({ type, name, outcome }) => [type, name ?? outcome]),
    ).toEqual([
      ["started", "read_file"],
      ["settled", "ok"],
      ["started", "no_such_tool"],
      ["settled", "error"],
    ]);
    expect(events[0]).toMatchObject({ args });
    expect(events[1]!.ref).toBe(events[0]!.ref);
    expect(JSON.stringify(events[1]!.result)).toContain("hello");
    expect(events[3]).toMatchObject({
      failure: expect.stringContaining("no_such_tool"),
    });
  } finally {
    await new Promise((closed) => bridge.close(closed));
  }
}, 120_000);

/** Runs a toolkit script with `input` on its stdin. */
const withInput = (
  script: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  input: string,
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((settle) => {
    const child = execFile(
      process.execPath,
      [script, ...args],
      {
        env: { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent", ...env },
      },
      (error, stdout, stderr) =>
        settle({
          code: error ? ((error as { code?: number }).code ?? -1) : 0,
          stdout,
          stderr,
        }),
    );
    child.stdin?.end(input);
  });

it("rene call writes stdin's raw text into one field, and receipts a declaration on stderr", async () => {
  const root = await createTestTempDirectory("rene-call-stdin-");
  const env = { REA_TOOLBOX_ROOTS: root };
  const RENE = resolve("scripts/rene.mjs");
  // Quotes, $ and backslashes arrive as written: no JSON escaping, no expansion.
  const body = 'first line\n"quoted" and $HOME and \\n stay as written\n';
  const target = join(root, "out.txt");
  const written = await withInput(
    RENE,
    [
      "call",
      "write_file",
      JSON.stringify({ path: target }),
      "--stdin-field",
      "content",
    ],
    env,
    body,
  );
  expect(written.code).toBe(0);
  expect(await readFile(target, "utf8")).toBe(body);
  // The flag may come first.
  const first = join(root, "first.txt");
  const flagFirst = await withInput(
    RENE,
    [
      "call",
      "write_file",
      "--stdin-field",
      "content",
      JSON.stringify({ path: first }),
    ],
    env,
    body,
  );
  expect(flagFirst.code).toBe(0);
  expect(await readFile(first, "utf8")).toBe(body);
  // Without its other arguments on the line, --stdin-field is refused.
  const refused = await withInput(
    RENE,
    ["call", "write_file", "-", "--stdin-field", "content"],
    env,
    body,
  );
  expect(refused.code).toBe(2);

  const declared = await withInput(
    RENE,
    [
      "call",
      "record_topic",
      JSON.stringify({ kind: "thread", title: "CLI test" }),
    ],
    env,
    "",
  );
  expect(declared.code).toBe(0);
  expect(declared.stderr).toMatch(
    /^rene call: declared topic [0-9a-f-]{36}\n$/u,
  );
  // rea, REA's command, answers rene's commands too.
  const viaRea = await rea(["tools", "describe", "read_file"], env);
  expect(viaRea.code).toBe(0);
}, 120_000);
