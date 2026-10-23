// Claude Code's status line for a workbench session. Claude Code runs it
// after each reply with the session's state on stdin, including the plan's
// live rate limits (from the API's own response). It keeps only those,
// with when they came, in REA_STATUS_FILE for the usage bar, and prints a
// short line; when the user has a status line of their own
// (REA_USER_STATUSLINE), that runs on the same input and its output is shown
// instead.

import { spawnSync } from "node:child_process";
import { rename, writeFile } from "node:fs/promises";

const MAX_INPUT = 1024 * 1024;

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > MAX_INPUT) break;
  chunks.push(chunk);
}
const text = Buffer.concat(chunks).toString("utf8");
let input;
try {
  input = JSON.parse(text);
} catch {
  input = undefined;
}

const limits = input?.rate_limits;
const file = process.env.REA_STATUS_FILE;
if (file && limits && typeof limits === "object") {
  const record = {
    at: Date.now(),
    session: typeof input.session_id === "string" ? input.session_id : null,
    available: input.rate_limits_available !== false,
    rate_limits: limits,
  };
  try {
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  } catch {
    // The usage bar falls back to Claude Code's cached figures.
  }
}

const own = process.env.REA_USER_STATUSLINE;
if (own) {
  const result = spawnSync("/bin/sh", ["-c", own], {
    input: text,
    encoding: "utf8",
    timeout: 5000,
  });
  process.stdout.write(result.stdout ?? "");
} else {
  const part = (label, entry) =>
    typeof entry?.used_percentage === "number"
      ? `${label} ${Math.round(entry.used_percentage)}%`
      : undefined;
  process.stdout.write(
    [part("5h", limits?.five_hour), part("7d", limits?.seven_day)]
      .filter(Boolean)
      .join(" · "),
  );
}
