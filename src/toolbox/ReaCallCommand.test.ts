import { describe, expect, it } from "vitest";

import {
  declaredTopicIds,
  parseReaCallCommand,
  parseShellLine,
  reaOnlyShellLine,
} from "./ReaCallCommand.js";

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

describe("shell lines that run only rea", () => {
  it("reads redirections out of commands and skips here-document bodies", () => {
    expect(
      parseShellLine(
        `rea call record_topic - 2>/dev/null <<'EOF'\n{"kind":"thread"}\nEOF\nrea tools`,
      ),
    ).toEqual({
      commands: [
        {
          after: "",
          words: ["rea", "call", "record_topic", "-"],
          redirections: [
            { operator: ">", target: "/dev/null" },
            { operator: "<<", target: "EOF" },
          ],
        },
        { after: "\n", words: ["rea", "tools"], redirections: [] },
      ],
      substitutes: false,
    });
  });

  it("allows rea calls, rea tools and filters reading their output", () => {
    for (const line of [
      `rea call read_file '{"path":"/x"}'`,
      `rea call read_file '{"path":"/x"}' | head -c 400`,
      `rea call search_text '{"query":"q","root":"/r"}' 2>&1 | jq '.normalized_result' | tail -n 5`,
      `rea tools search source graph | wc -l`,
      `rea call a_tool '{}' && rea call b_tool '{}' > /dev/null`,
      `rea call record_topic - <<'EOF'\n{"kind":"thread","title":"T"}\nEOF`,
    ])
      expect(reaOnlyShellLine(line)).toMatchObject({ ok: true });
    expect(
      reaOnlyShellLine(`rea call record_topic '{"kind":"thread"}' | head`),
    ).toEqual({
      ok: true,
      calls: [{ tool: "record_topic", args: { kind: "thread" } }],
    });
  });

  it("refuses lines that run or write anything past rea", () => {
    const refused: readonly (readonly [string, string])[] = [
      ["ls -la", "ls isn't rea"],
      [`rea call read_file '{}' && cat /etc/passwd`, "cat isn't rea"],
      [`head /etc/passwd`, "head isn't rea"],
      [
        `rea call read_file '{}' | head /etc/passwd`,
        "head /etc/passwd reads a file",
      ],
      [
        `rea call read_file '{}' | jq . secrets.json`,
        "jq secrets.json reads a file",
      ],
      [
        `rea call read_file '{}' > out.json`,
        "> out.json writes a file rea doesn't record",
      ],
      [
        `rea call read_file "$(cat args.json)"`,
        "it runs a command or process substitution",
      ],
      [
        "rea call read_file `cat a`",
        "it runs a command or process substitution",
      ],
      [
        `rea call read_file '{}' | tee >(sh)`,
        "it runs a command or process substitution",
      ],
      [
        `rea decompile ./a.out`,
        "`rea decompile ./a.out` isn't a rea call or rea tools command",
      ],
      [
        `rea call read_file 'not json'`,
        "`rea call read_file not json` isn't a rea call or rea tools command",
      ],
      [`rea call read_file '{`, "it has an unterminated quote"],
      ["", "it runs no command"],
    ];
    for (const [line, reason] of refused)
      expect(reaOnlyShellLine(line)).toEqual({ ok: false, reason });
  });

  it("reads the topics a rea call record_topic printed", () => {
    const evidence = JSON.stringify({
      operation: "record_topic",
      normalized_result: { topic_id: "t1", title: "T" },
    });
    expect(declaredTopicIds(`${evidence}\n`)).toEqual(["t1"]);
    expect(
      declaredTopicIds(
        `${JSON.stringify({ operation: "read_file", normalized_result: {} })}\nInput validation error: title is required\n`,
      ),
    ).toEqual([]);
  });
});
