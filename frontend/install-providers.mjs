#!/usr/bin/env node
// Installs analysis providers for the workbench from the terminal.
//
// Shows what would be downloaded and where, asks before downloading, then
// saves the installed paths in the workbench settings file. It then checks
// for newer releases REA accepts and asks before updating. start.sh runs
// this before launching the workbench; the Providers page does the same.

import { createInterface } from "node:readline/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  createInstaller,
  defaultProvidersDir,
  InstallError,
} from "./providerInstall.mjs";
import { createSettings } from "./settings.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values: options } = parseArgs({
  options: {
    yes: { type: "boolean", short: "y", default: false },
    "dry-run": { type: "boolean", default: false },
    "no-updates": { type: "boolean", default: false },
    only: { type: "string" },
    settings: {
      type: "string",
      default: join(here, ".workbench-settings.json"),
    },
    "providers-dir": { type: "string", default: defaultProvidersDir() },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (options.help) {
  console.log(`Usage: node frontend/install-providers.mjs [options]

Downloads pinned, checksum-verified releases of Java 21, Ghidra, the JADX
MCP JAR and Kuna into the providers folder, then saves their paths for REA.
Providers REA already points at another copy of are left alone unless named
with --only. Then checks for newer Java 21 and Ghidra 12.1.x releases and
asks before updating. Hopper, binwalk, sigrok-cli, gdb/pwndbg and Chromium
come with the REA container (frontend/container); IDA needs a license.

Options:
  -y, --yes             Install and update without asking.
  --dry-run             Show the plan (and available updates) and exit.
  --no-updates          Don't check for updates.
  --only ID,ID          Install just these (jdk, ghidra, jadx, kuna, apktool,
                        wabt, pwntools, unblob, mitmproxy).
  --settings PATH       Workbench settings file (default: frontend/.workbench-settings.json).
  --providers-dir PATH  Where providers go (default: ${defaultProvidersDir()}).
  -h, --help            Show this help.`);
  process.exit(0);
}

const settings = createSettings(options.settings);
await settings.load();
const installer = createInstaller({
  root: options["providers-dir"],
  settings,
});
const mib = (bytes) => `${Math.round(bytes / 1024 / 1024)} MiB`;
const STATE = {
  ready: "installed and in use",
  available: "installed, not in use yet",
  configured: "REA uses your own copy",
  missing: "not installed",
};
const PHASE = {
  start: "starting",
  verify: "checking SHA-256",
  unpack: "unpacking",
  build: "building with uv",
  check: "checking the installed version",
  installed: "installed",
  present: "already installed",
  cancelled: "cancelled",
};

/** Asks yes/no; --yes answers yes and no terminal answers no. */
async function confirm(question) {
  if (options.yes) return true;
  if (!process.stdin.isTTY) {
    console.log("Not changing anything: no terminal to ask. Rerun with --yes.");
    return false;
  }
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer = await prompt.question(`${question} [y/N] `);
  prompt.close();
  return /^y(es)?$/i.test(answer.trim());
}

/** Prints progress events, one line per 10% of each download. */
function progressPrinter(labels) {
  const lastPercent = new Map();
  return (event) => {
    if (event.type !== "progress") return;
    const label = labels.get(event.id);
    if (event.phase === "download") {
      const percent = Math.floor((event.received / event.total) * 10) * 10;
      if (lastPercent.get(event.id) === percent) return;
      lastPercent.set(event.id, percent);
      console.log(`  ${label}: downloading ${percent}%`);
    } else if (event.phase === "failed") {
      console.log(`  ${label}: failed: ${event.error}`);
    } else {
      console.log(`  ${label}: ${PHASE[event.phase] ?? event.phase}`);
    }
  };
}

/** Runs one install or update; returns whether everything finished. */
async function run(start, labels) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  try {
    const result = await start({
      signal: controller.signal,
      onEvent: progressPrinter(labels),
    });
    if (result.saved.length)
      console.log(`Saved ${result.saved.join(", ")} for REA.`);
    return result.failed.length === 0 && !result.cancelled;
  } catch (cause) {
    console.error(cause instanceof InstallError ? cause.message : cause);
    return false;
  } finally {
    process.off("SIGINT", stop);
  }
}

async function chooseComponents(plan) {
  const only = options.only
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = only?.filter(
    (id) => !plan.components.some((component) => component.id === id),
  );
  if (unknown?.length) {
    console.error(
      `Unknown provider: ${unknown.join(", ")}. Choose from ${plan.components.map((c) => c.id).join(", ")}.`,
    );
    process.exit(2);
  }
  const wanted = await installer.withDependencies(
    only ??
      plan.components
        .filter((component) => component.recommended)
        .map((component) => component.id),
  );
  return plan.components.filter((component) => wanted.includes(component.id));
}

async function installMissing(plan) {
  const chosen = await chooseComponents(plan);
  console.log(`Analysis providers (folder: ${plan.root})`);
  for (const component of plan.components) {
    if (!component.used && !chosen.includes(component)) continue;
    const mark = chosen.includes(component) ? "+" : " ";
    const size = component.downloadBytes
      ? `, download ${mib(component.downloadBytes)}`
      : "";
    console.log(
      `  ${mark} ${component.label} ${component.version}: ${STATE[component.state]}${size}${component.blocked ? ` (${component.blocked})` : ""}`,
    );
  }
  if (chosen.length === 0) {
    const off = plan.components.filter((c) => !c.used).map((c) => c.label);
    console.log(
      `Nothing to install.${off.length ? ` Not used: ${off.join(", ")} (turn them on in the workbench's Providers page).` : ""}`,
    );
    return true;
  }
  const total = chosen.reduce((sum, c) => sum + c.downloadBytes, 0);
  const disk = chosen.reduce((sum, c) => sum + c.diskBytes, 0);
  console.log(
    `\nPlan: install ${chosen.map((c) => c.label).join(", ")} (download ${mib(total)}, about ${mib(disk)} on disk).`,
  );
  for (const component of chosen) {
    if (!component.downloadBytes) continue;
    if (component.kind === "python")
      console.log(
        `  ${component.label}: built with uv from PyPI: ${component.packages.join(" ")}`,
      );
    else console.log(`  ${component.url}\n    SHA-256 ${component.sha256}`);
    for (const extra of component.extras)
      console.log(`  ${extra.url}\n    SHA-256 ${extra.sha256}`);
  }
  console.log(`Paths are saved in ${options.settings}.`);
  if (options["dry-run"]) return true;
  if (!(await confirm("Install these?"))) return true;
  const labels = new Map(plan.components.map((c) => [c.id, c.label]));
  return run(
    (callbacks) =>
      installer.install(
        chosen.map((c) => c.id),
        callbacks,
      ),
    labels,
  );
}

/** Offers newer releases of providers this workbench installed and uses. */
async function offerUpdates(plan) {
  const ours = new Set(
    plan.components
      .filter((component) => component.state === "ready" && component.used)
      .map((component) => component.id),
  );
  if (ours.size === 0) return true;
  const { updates, unchecked } = await installer.checkUpdates();
  for (const { label, reason } of unchecked)
    console.log(`Couldn't check ${label} for updates: ${reason}`);
  const relevant = updates.filter((update) => ours.has(update.id));
  if (relevant.length === 0) {
    if (unchecked.length === 0) console.log("Providers are up to date.");
    return true;
  }
  console.log("\nUpdates available:");
  for (const update of relevant)
    console.log(
      `  ${update.label}: ${update.from} → ${update.to} (download ${mib(update.release.size)})\n    ${update.release.url}\n    SHA-256 ${update.release.sha256}`,
    );
  if (options["dry-run"]) return true;
  if (!(await confirm("Install these updates?"))) return true;
  const labels = new Map(relevant.map((update) => [update.id, update.label]));
  return run(
    (callbacks) => installer.applyUpdates(relevant, callbacks),
    labels,
  );
}

const plan = await installer.plan();
if (!plan.supported) {
  console.log(
    `Provider downloads support Linux x64 and arm64, not ${plan.host}. Set provider paths on the workbench's Providers page instead.`,
  );
  process.exit(0);
}
let ok = await installMissing(plan);
if (!options["no-updates"])
  ok = (await offerUpdates(await installer.plan())) && ok;
process.exit(ok ? 0 : 1);
