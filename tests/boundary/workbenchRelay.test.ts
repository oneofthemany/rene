import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

// The workbench's MCP relay (frontend/relay.mjs) passes an agent's MCP
// traffic to `rea mcp` unchanged and reports each tools/call to the bridge,
// as `rea call` does, through src/toolbox/HistoryReport.ts.

it("relays MCP calls unchanged and reports them to the bridge", async () => {
  const root = await createTestTempDirectory("rea-workbench-relay-");
  const file = join(root, "note.txt");
  await writeFile(file, "hello\n");
  const events: Record<string, unknown>[] = [];
  const tokens = new Set<unknown>();
  const bridge = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      tokens.add(request.headers["x-rea-relay-token"]);
      events.push(JSON.parse(body) as Record<string, unknown>);
      response.end("{}");
    });
  });
  await new Promise<void>((listening) =>
    bridge.listen(0, "127.0.0.1", listening),
  );
  const { port } = bridge.address() as AddressInfo;
  const report = join(root, "relay-report.json");
  await writeFile(
    report,
    JSON.stringify({ url: `http://127.0.0.1:${port}/api/relay`, token: "t" }),
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("frontend/relay.mjs"),
      "--report",
      report,
      "--",
      process.execPath,
      resolve("scripts/rea.mjs"),
      "mcp",
    ],
    env: {
      PATH: process.env.PATH ?? "",
      REA_LOG_LEVEL: "silent",
      REA_TOOLBOX_ROOTS: root,
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => undefined);
  const client = new Client({ name: "relay-test", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "read_file",
      arguments: { path: file },
    });
    expect(JSON.stringify(result.content)).toContain("hello");
  } finally {
    await client.close();
    await transport.close();
  }
  // The relay drains its reports before it exits.
  const deadline = Date.now() + 5_000;
  while (events.length < 2 && Date.now() < deadline)
    await new Promise((settle) => setTimeout(settle, 50));
  await new Promise((closed) => bridge.close(closed));

  expect([...tokens]).toEqual(["t"]);
  expect(events.map(({ type }) => type)).toEqual(["started", "settled"]);
  expect(events[0]).toMatchObject({ name: "read_file", args: { path: file } });
  expect(events[1]).toMatchObject({ ref: events[0]!.ref, outcome: "ok" });
  expect(JSON.stringify(events[1]!.result)).toContain("hello");
}, 120_000);
