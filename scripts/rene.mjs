#!/usr/bin/env node

// rene's commands. rene is this fork's tool in its own right; `rea` stays
// REA's command (MCP, analysis) and still answers call, tools and daemon.
//
//   rene call <tool> [<json>|-]          run one rene tool
//   rene tools [search|describe] …       find tools and their inputs
//   rene daemon [--socket <path>] …      keep one session for many calls
//   rene agent [options] [<request>…]    a local troubleshooting agent
//
// All run from the same compiled runtime (dist/mcp).

import { access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `Usage: rene <command>

Commands:
  call     Run one rene tool:  rene call <tool> '<json>'  (rene call --help)
  tools    Find tools and show their inputs:  rene tools search <words>
  daemon   Keep one rene session for many calls:  rene daemon --socket <path>
  agent    Troubleshoot and investigate with rene's tools on a local or cloud
           model (rene agent --help)
`;
const TOOL_COMMANDS = new Set(["call", "tools", "daemon"]);
/** Exit status of a writer terminated by SIGPIPE (128 + 13). */
const SIGPIPE_EXIT_STATUS = 141;

const args = process.argv.slice(2);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { default: packageJson } = await import("../package.json", {
  with: { type: "json" },
});
process.env.REA_PACKAGE_VERSION = packageJson.version;

let stdoutClosed = false;
// A reader that closes the pipe early (rene call … | head) has declined the
// rest; stop writing and exit as a SIGPIPE-terminated writer does.
process.stdout.on("error", (cause) => {
  if (cause?.code !== "EPIPE") throw cause;
  stdoutClosed = true;
  process.exitCode = SIGPIPE_EXIT_STATUS;
});

const command = args[0];
if (command !== "agent" && !TOOL_COMMANDS.has(command)) {
  process.stderr.write(USAGE);
  process.exitCode = args.length === 0 || command === "--help" ? 0 : 2;
} else {
  const runtime = resolve(
    packageRoot,
    command === "agent" ? "dist/mcp/agentCli.js" : "dist/mcp/toolCli.js",
  );
  try {
    await access(runtime);
  } catch {
    process.stderr.write(
      `rene's compiled runtime is missing. Run \`npm ci && npm run build:cached\` in ${packageRoot}, then try again.\n`,
    );
    process.exit(1);
  }
  const { readProcessStdin, runToolCli } =
    await import("../dist/mcp/toolCli.js");
  const io = {
    env: process.env,
    writeStdout: (text) => {
      if (!stdoutClosed) process.stdout.write(text);
    },
    writeStderr: (text) => process.stderr.write(text),
    readStdin: readProcessStdin,
  };
  if (command === "agent") {
    const { runAgentCli } = await import("../dist/mcp/agentCli.js");
    process.exitCode = await runAgentCli(args.slice(1), io);
  } else {
    const status = await runToolCli(args, io);
    // A daemon keeps serving after startup; it exits through its shutdown.
    if (status !== 0 || command !== "daemon")
      process.exitCode = stdoutClosed ? SIGPIPE_EXIT_STATUS : status;
  }
}
