import type { Tool } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { argumentForm, isSchemaRefusal, missingToolHint } from "./toolCli.js";

// A call refused for its arguments or its tool's name says the right form,
// so the agent's next call can be the fixed one rather than a lookup.

const readFile = {
  name: "read_file",
  inputSchema: {
    type: "object",
    properties: {
      start_line: { type: "integer", default: 1 },
      path: { type: "string" },
      mode: { enum: ["text", "lines"] },
    },
    required: ["path"],
    examples: [{ path: "/home/analyst/README.md" }],
  },
} as unknown as Tool;

it("names a tool's arguments, required first, with an example call", () => {
  expect(argumentForm(readFile)).toBe(
    "read_file takes path (string, required), start_line (integer, default 1), mode (text|lines). " +
      `For example: rene call read_file '{"path":"/home/analyst/README.md"}'. ` +
      "`rene tools describe read_file` shows each argument's meaning.",
  );
});

it("tells a schema refusal from the tool's own errors", () => {
  expect(
    isSchemaRefusal(
      'Input validation error: Invalid arguments for tool read_file: Unrecognized key: "end_line"',
    ),
  ).toBe(true);
  // A value the tool rejected: its message says which, the form wouldn't help.
  expect(
    isSchemaRefusal(
      JSON.stringify({
        error: {
          category: "invalid_input",
          message: "edit_file: old_text doesn't occur in /a.",
        },
      }),
    ),
  ).toBe(false);
  expect(isSchemaRefusal("Request timed out")).toBe(false);
});

it("points a missing tool's name at the ones near it", () => {
  const tools = ["read_file", "write_file", "run_command"].map(
    (name) => ({ name, inputSchema: { type: "object" } }) as unknown as Tool,
  );
  expect(missingToolHint("read_files", tools)).toBe(
    "No tool is named read_files. Near it: read_file, write_file. `rene tools search <words>` finds tools.",
  );
  expect(missingToolHint("zzz", tools)).toBe(
    "No tool is named zzz. `rene tools search <words>` finds tools.",
  );
});
