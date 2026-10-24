// Claude Code's status line for a workbench session. Claude Code runs it
// after each reply with the session's state on stdin, including the plan's
// live rate limits (from the API's own response). It keeps only those,
// with when they came, in REA_STATUS_FILE for the usage bar (and each change
// in REA_STATUS_HISTORY, for the budget panel's pace), and prints a
// short line; when the user has a status line of their own
// (REA_USER_STATUSLINE), that runs on the same input and its output is shown
// instead.

import { spawnSync } from "node:child_process";
import {
  appendFile,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";

const MAX_INPUT = 1024 * 1024;
// Every reading that changed, in REA_STATUS_HISTORY (one JSON line each), for
// the budget panel's pace: past this size, only the last 8 days are kept.
const MAX_HISTORY = 1024 * 1024;
const HISTORY_MS = 8 * 24 * 60 * 60_000;

const WINDOWS = ["five_hour", "seven_day"];
const changed = (previous, record) =>
  !previous?.available ||
  WINDOWS.some(
    (name) =>
      previous.rate_limits?.[name]?.used_percentage !==
        record.rate_limits[name]?.used_percentage ||
      previous.rate_limits?.[name]?.resets_at !==
        record.rate_limits[name]?.resets_at,
  );

async function keep(history, record) {
  const line = JSON.stringify({
    at: record.at,
    rate_limits: Object.fromEntries(
      WINDOWS.filter((name) => record.rate_limits[name]).map((name) => [
        name,
        {
          used_percentage: record.rate_limits[name].used_percentage,
          resets_at: record.rate_limits[name].resets_at,
        },
      ]),
    ),
  });
  await appendFile(history, `${line}\n`, { mode: 0o600 });
  if ((await stat(history)).size <= MAX_HISTORY) return;
  const kept = (await readFile(history, "utf8")).split("\n").filter((text) => {
    try {
      return JSON.parse(text).at >= record.at - HISTORY_MS;
    } catch {
      return false;
    }
  });
  await writeFile(`${history}.tmp`, kept.map((text) => `${text}\n`).join(""), {
    mode: 0o600,
  });
  await rename(`${history}.tmp`, history);
}

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
  const previous = await readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  try {
    await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${file}.tmp`, file);
  } catch {
    // The usage bar falls back to Claude Code's cached figures.
  }
  const history = process.env.REA_STATUS_HISTORY;
  if (history && record.available && changed(previous, record))
    await keep(history, record).catch(() => {
      // The budget panel then measures from fewer readings.
    });
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
