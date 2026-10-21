import { describe, expect, it } from "vitest";

import { parseReaCallCommand } from "./ReaCallCommand.js";

describe("rea call in a shell command line", () => {
  it("reads the tool and JSON arguments through shell quoting", () => {
    expect(
      parseReaCallCommand(`rea call read_file '{"path":"/a b/it\\'s"}'`),
    ).toBeUndefined(); // An unterminated quote: the shell would not run it.
    expect(
      parseReaCallCommand(`rea call read_file '{"path":"/a b/c"}'`),
    ).toEqual({ tool: "read_file", args: { path: "/a b/c" } });
    expect(
      parseReaCallCommand(`rea call search_text "{\\"query\\":\\"x y\\"}"`),
    ).toEqual({ tool: "search_text", args: { query: "x y" } });
    expect(parseReaCallCommand(`rea call binary_session`)).toEqual({
      tool: "binary_session",
      args: {},
    });
  });

  it("finds the call among other commands, assignments and launchers", () => {
    const args = { path: "/x" };
    for (const line of [
      `cd /tmp && rea call read_file '{"path":"/x"}' | head -c 400`,
      `REA_DAEMON_SOCKET=/s.sock rea call read_file '{"path":"/x"}'`,
      `node /opt/rene/scripts/rea.mjs call read_file '{"path":"/x"}' > out.json`,
      `npx --no-install rea call read_file '{"path":"/x"}'; echo $?`,
      `/home/u/.local/bin/rea call read_file '{"path":"/x"}'`,
    ])
      expect(parseReaCallCommand(line)).toEqual({ tool: "read_file", args });
  });

  it("reports arguments it can't see as unknown, and ignores what isn't a call", () => {
    expect(
      parseReaCallCommand(`rea call record_topic - <<'EOF'\n{}\nEOF`),
    ).toEqual({ tool: "record_topic", args: null });
    expect(parseReaCallCommand(`rea call read_file "$ARGS"`)).toEqual({
      tool: "read_file",
      args: null,
    });
    for (const line of [
      "ls -la",
      "rea tools search read",
      "echo rea call read_file '{}'",
      "rea call read_file 'not json'",
      "rea call read_file '[1]'",
      "rea call ReadFile '{}'",
    ])
      expect(parseReaCallCommand(line)).toBeUndefined();
  });
});
