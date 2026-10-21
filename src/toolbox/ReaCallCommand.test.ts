import { describe, expect, it } from "vitest";

import {
  declaredTopicIds,
  parseReaCallCommands,
  parseShellLine,
  reaOnlyShellLine,
} from "./ReaCallCommand.js";

const firstCall = (line: string) => parseReaCallCommands(line)[0];

describe("rene call in a shell command line", () => {
  it("reads every call on a line, in order", () => {
    expect(
      parseReaCallCommands(
        `rene call record_topic '{"kind":"thread"}' | jq -r .id; rene call read_file '{"path":"/x"}' && rene call edit_file - <<'EOF'\n{}\nEOF`,
      ),
    ).toEqual([
      { tool: "record_topic", args: { kind: "thread" } },
      { tool: "read_file", args: { path: "/x" } },
      { tool: "edit_file", args: null },
    ]);
    expect(parseReaCallCommands("ls -la")).toEqual([]);
  });

  it("reads the tool and JSON arguments through shell quoting", () => {
    expect(
      firstCall(`rene call read_file '{"path":"/a b/it\\'s"}'`),
    ).toBeUndefined(); // An unterminated quote: the shell would not run it.
    expect(firstCall(`rene call read_file '{"path":"/a b/c"}'`)).toEqual({
      tool: "read_file",
      args: { path: "/a b/c" },
    });
    expect(
      firstCall(`rene call search_text "{\\"query\\":\\"x y\\"}"`),
    ).toEqual({ tool: "search_text", args: { query: "x y" } });
    expect(firstCall(`rene call binary_session`)).toEqual({
      tool: "binary_session",
      args: {},
    });
  });

  it("finds the call among other commands, assignments and launchers", () => {
    const args = { path: "/x" };
    for (const line of [
      `cd /tmp && rene call read_file '{"path":"/x"}' | head -c 400`,
      `REA_DAEMON_SOCKET=/s.sock rene call read_file '{"path":"/x"}'`,
      `node /opt/rene/scripts/rea.mjs call read_file '{"path":"/x"}' > out.json`,
      `npx --no-install rene call read_file '{"path":"/x"}'; echo $?`,
      `/home/u/.local/bin/rene call read_file '{"path":"/x"}'`,
    ])
      expect(firstCall(line)).toEqual({ tool: "read_file", args });
  });

  it("reports arguments it can't see as unknown, and ignores what isn't a call", () => {
    expect(firstCall(`rene call record_topic - <<'EOF'\n{}\nEOF`)).toEqual({
      tool: "record_topic",
      args: null,
    });
    expect(firstCall(`rene call read_file "$ARGS"`)).toEqual({
      tool: "read_file",
      args: null,
    });
    for (const line of [
      "ls -la",
      "rene tools search read",
      "echo rene call read_file '{}'",
      "rene call read_file 'not json'",
      "rene call read_file '[1]'",
      "rene call ReadFile '{}'",
    ])
      expect(firstCall(line)).toBeUndefined();
  });
});

describe("rea, the older name, and --stdin-field", () => {
  it("still reads rea call, and reads a field from stdin as unknown arguments", () => {
    expect(parseReaCallCommands(`rea call read_file '{"path":"/x"}'`)).toEqual([
      { tool: "read_file", args: { path: "/x" } },
    ]);
    expect(
      parseReaCallCommands(
        `rene call write_file '{"path":"/x"}' --stdin-field content <<'EOF'\nline one\n$NOT_EXPANDED\nEOF`,
      ),
    ).toEqual([{ tool: "write_file", args: null }]);
    // --stdin-field needs the other arguments on the line.
    expect(
      parseReaCallCommands(`rene call write_file - --stdin-field content`),
    ).toEqual([]);
    expect(
      reaOnlyShellLine(
        `rene call write_file '{"path":"/x"}' --stdin-field content <<'EOF'\nhi\nEOF`,
      ),
    ).toMatchObject({ ok: true });
    // rene agent starts an agent, not a tool call.
    expect(reaOnlyShellLine(`rene agent "look around"`)).toMatchObject({
      ok: false,
    });
  });

  it("reads a declaration from the stderr receipt, under either name", () => {
    expect(declaredTopicIds("t1\nrene call: declared topic t1\n")).toEqual([
      "t1",
    ]);
    expect(declaredTopicIds("rea call: declared topic t2\n")).toEqual(["t2"]);
    expect(declaredTopicIds("rene call: declared topic \n")).toEqual([]);
  });
});

describe("shell lines that run only rene", () => {
  it("reads redirections out of commands and skips here-document bodies", () => {
    expect(
      parseShellLine(
        `rene call record_topic - 2>/dev/null <<'EOF'\n{"kind":"thread"}\nEOF\nrene tools`,
      ),
    ).toEqual({
      commands: [
        {
          after: "",
          words: ["rene", "call", "record_topic", "-"],
          redirections: [
            { operator: ">", target: "/dev/null" },
            { operator: "<<", target: "EOF" },
          ],
        },
        { after: "\n", words: ["rene", "tools"], redirections: [] },
      ],
      substitutes: false,
    });
  });

  it("allows rene calls, rene tools and filters reading their output", () => {
    for (const line of [
      `rene call read_file '{"path":"/x"}'`,
      `rene call read_file '{"path":"/x"}' | head -c 400`,
      `rene call search_text '{"query":"q","root":"/r"}' 2>&1 | jq '.normalized_result' | tail -n 5`,
      `rene tools search source graph | wc -l`,
      `rene call a_tool '{}' && rene call b_tool '{}' > /dev/null`,
      `rene call record_topic - <<'EOF'\n{"kind":"thread","title":"T"}\nEOF`,
    ])
      expect(reaOnlyShellLine(line)).toMatchObject({ ok: true });
    expect(
      reaOnlyShellLine(`rene call record_topic '{"kind":"thread"}' | head`),
    ).toEqual({
      ok: true,
      calls: [{ tool: "record_topic", args: { kind: "thread" } }],
    });
  });

  it("refuses lines that run or write anything past rea", () => {
    const refused: readonly (readonly [string, string])[] = [
      ["ls -la", "ls isn't rene"],
      [`rene call read_file '{}' && cat /etc/passwd`, "cat isn't rene"],
      [`head /etc/passwd`, "head isn't rene"],
      [
        `rene call read_file '{}' | head /etc/passwd`,
        "head /etc/passwd reads a file",
      ],
      [
        `rene call read_file '{}' | jq . secrets.json`,
        "jq secrets.json reads a file",
      ],
      [
        `rene call read_file '{}' > out.json`,
        "> out.json writes a file rene doesn't record",
      ],
      [
        `rene call read_file "$(cat args.json)"`,
        "it runs a command or process substitution",
      ],
      [
        "rene call read_file `cat a`",
        "it runs a command or process substitution",
      ],
      [
        `rene call read_file '{}' | tee >(sh)`,
        "it runs a command or process substitution",
      ],
      [
        `rene decompile ./a.out`,
        "`rene decompile ./a.out` isn't a rene call or rene tools command",
      ],
      [
        `rene call read_file 'not json'`,
        "`rene call read_file not json` isn't a rene call or rene tools command",
      ],
      [`rene call read_file '{`, "it has an unterminated quote"],
      ["", "it runs no command"],
    ];
    for (const [line, reason] of refused)
      expect(reaOnlyShellLine(line)).toEqual({ ok: false, reason });
  });

  it("reads the topics a rene call record_topic printed", () => {
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
