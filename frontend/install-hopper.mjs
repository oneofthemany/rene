#!/usr/bin/env node
// Offers Hopper from the terminal. `rea setup --install-hopper` owns the
// install: it shows its own plan, asks for approval, verifies the package and
// runs the system package manager, which asks for your password itself. This
// script only checks whether Hopper is needed and starts setup when you agree.

import { execFile, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hopperPendingReboot } from "./hopperSetup.mjs";
import { createSettings } from "./settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    "dry-run": { type: "boolean", default: false },
    settings: {
      type: "string",
      default: join(here, ".workbench-settings.json"),
    },
    rea: { type: "string", default: resolve(here, "../scripts/rea.mjs") },
  },
});

const settings = createSettings(options.settings);
await settings.load();
// Setup registers agents with the same provider paths the workbench uses.
const env = settings.environment(process.env);

/** rea doctor owns Hopper's readiness; an unhealthy report still prints JSON. */
const hopperReady = () =>
  new Promise((resolvePromise) =>
    execFile(
      process.execPath,
      [options.rea, "doctor", "--provider", "hopper", "--format", "json"],
      { env, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
      (_error, stdout) => {
        try {
          const report = JSON.parse(stdout);
          resolvePromise(
            report.checks?.some((check) => check.name === "hopper" && check.ok),
          );
        } catch {
          resolvePromise(false);
        }
      },
    ),
  );

const REBOOT =
  "Hopper is installed into the next system deployment; restart your computer to finish.";

if (process.platform !== "linux" && process.platform !== "darwin") {
  console.log("Hopper isn't available on this system.");
  process.exit(0);
}
if (await hopperReady()) {
  console.log("Hopper: installed.");
  process.exit(0);
}
if (await hopperPendingReboot()) {
  console.log(`Hopper: ${REBOOT}`);
  process.exit(0);
}
console.log(
  "Hopper (optional; Ghidra and Kuna already cover native analysis): not installed.",
);
if (options["dry-run"]) {
  console.log("  Would offer: rea setup --install-hopper");
  process.exit(0);
}
if (!process.stdin.isTTY) {
  console.log("  Install it from the workbench's Providers page.");
  process.exit(0);
}
const prompt = createInterface({
  input: process.stdin,
  output: process.stdout,
});
const answer = await prompt.question(
  "Install Hopper with REA's setup? It shows its plan first, then your system asks for your password. [y/N] ",
);
prompt.close();
if (!/^y(es)?$/i.test(answer.trim())) {
  console.log("Skipping Hopper.");
  process.exit(0);
}

const code = await new Promise((resolvePromise) =>
  spawn(process.execPath, [options.rea, "setup", "--install-hopper"], {
    env,
    stdio: "inherit",
  }).on("exit", (exitCode) => resolvePromise(exitCode ?? 1)),
);
if (await hopperPendingReboot()) console.log(REBOOT);
process.exit(code);
