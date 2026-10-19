// Provider downloads for the workbench.
//
// REA itself never installs Java, Ghidra, JADX or Kuna: it reads their
// locations from its environment. The workbench can fetch them so a fresh
// checkout becomes usable. Each provider is one pinned upstream release whose
// SHA-256 is recorded below; nothing else is downloaded, nothing outside the
// providers directory is written, and no administrator access is used. A
// finished install is published by one rename, with a marker that records
// what it is, so a directory with a valid marker is complete. Saving the
// resulting paths goes through settings.mjs, which keeps its own backup.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { RELEASES } from "./providerReleases.mjs";
import {
  compareVersions,
  findUpdates,
  loadPins,
  savePins,
} from "./providerUpdates.mjs";

const run = promisify(execFile);
const MARKER = ".rea-workbench-install.json";
const MiB = 1024 * 1024;

/** Default location: the workbench's folder under the XDG data directory. */
export const defaultProvidersDir = (env = process.env) =>
  join(
    env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "rea-workbench",
    "providers",
  );

export class InstallError extends Error {}

const describe = (cause) =>
  cause instanceof Error ? cause.message : String(cause);

const finalDir = (root, release) =>
  join(root, `${release.id}-${release.version}`);
const settingValues = (root, release) =>
  Object.fromEntries(
    Object.entries(release.settings).map(([name, relative]) => [
      name,
      relative
        ? join(finalDir(root, release), relative)
        : finalDir(root, release),
    ]),
  );

/** Whether this release is unpacked here, judged by its marker alone. */
async function installed(root, release) {
  try {
    const marker = JSON.parse(
      await readFile(join(finalDir(root, release), MARKER), "utf8"),
    );
    if (marker.sha256 !== release.sha256) return false;
    for (const path of Object.values(settingValues(root, release)))
      await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function download(release, file, signal, report) {
  const response = await fetch(release.url, { signal, redirect: "follow" });
  if (!response.ok || !response.body)
    throw new InstallError(
      `${release.label}: download failed with HTTP ${response.status}.`,
    );
  const hash = createHash("sha256");
  let received = 0;
  let reported = 0;
  const counted = Readable.fromWeb(response.body).map(
    (chunk) => {
      received += chunk.length;
      if (received > release.size)
        throw new InstallError(
          `${release.label}: the download is larger than the pinned ${release.size} bytes.`,
        );
      hash.update(chunk);
      if (
        received - reported >= release.size / 100 ||
        received === release.size
      ) {
        reported = received;
        report({ phase: "download", received, total: release.size });
      }
      return chunk;
    },
    { signal },
  );
  await pipeline(counted, createWriteStream(file, { mode: 0o600 }), {
    signal,
  });
  report({ phase: "verify" });
  const digest = hash.digest("hex");
  if (received !== release.size || digest !== release.sha256)
    throw new InstallError(
      `${release.label}: the download does not match the pinned release (got ${received} bytes, SHA-256 ${digest}). Nothing was installed.`,
    );
}

/** Unpacks into `staging` and returns the folder that becomes the install. */
async function unpack(release, file, staging, signal) {
  if (release.archive === "file") {
    const folder = join(staging, "content");
    await mkdir(folder);
    await rename(file, join(folder, release.fileName));
    return folder;
  }
  const target = join(staging, "unpacked");
  await mkdir(target);
  // Both tools refuse absolute and ../ member names by default.
  const [command, args] =
    release.archive === "zip"
      ? ["unzip", ["-q", file, "-d", target]]
      : ["tar", ["-xzf", file, "-C", target, "--no-same-owner"]];
  try {
    await run(command, args, { signal, maxBuffer: 4 * MiB });
  } catch (cause) {
    if (cause.code === "ENOENT")
      throw new InstallError(
        `${release.label}: ${command} is needed to unpack ${release.archive} archives.`,
      );
    throw new InstallError(
      `${release.label}: ${command} failed: ${(cause.stderr || describe(cause)).trim()}`,
    );
  }
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory())
    throw new InstallError(
      `${release.label}: expected one top-level folder in the archive, found ${entries.length} entries.`,
    );
  return join(target, entries[0].name);
}

async function installOne(root, release, signal, report) {
  if (await installed(root, release)) {
    report({ phase: "present" });
    return;
  }
  await mkdir(root, { recursive: true, mode: 0o700 });
  const free = await statfs(root);
  const needed = release.size + release.diskBytes;
  if (free.bavail * free.bsize < needed)
    throw new InstallError(
      `${release.label}: needs about ${Math.ceil(needed / MiB)} MiB free in ${root}.`,
    );
  const staging = join(
    root,
    `.staging-${release.id}-${randomBytes(4).toString("hex")}`,
  );
  await mkdir(staging, { mode: 0o700 });
  try {
    const file = join(staging, "download");
    await download(release, file, signal, report);
    report({ phase: "unpack" });
    const content = await unpack(release, file, staging, signal);
    await writeFile(
      join(content, MARKER),
      `${JSON.stringify(
        {
          id: release.id,
          version: release.version,
          url: release.url,
          sha256: release.sha256,
          installedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
    signal.throwIfAborted();
    try {
      await rename(content, finalDir(root, release));
    } catch (cause) {
      // Another run finished the same release first; keep its copy.
      if (!(await installed(root, release))) {
        throw new InstallError(
          `${release.label}: ${finalDir(root, release)} already exists and is not a complete install from this workbench. Move it aside and retry.`,
          { cause },
        );
      }
    }
    report({ phase: "installed" });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** Removes staging folders a crashed run left behind a day or more ago. */
async function sweep(root) {
  let names;
  try {
    names = await readdir(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(".staging-")) continue;
    const path = join(root, name);
    const info = await stat(path).catch(() => undefined);
    if (info && Date.now() - info.mtimeMs > 24 * 3600_000)
      await rm(path, { recursive: true, force: true });
  }
}

/**
 * Installs releases one at a time; one failing doesn't stop the others.
 * Returns the paths of every release that is now installed.
 */
async function installEach(root, chosen, signal, emit) {
  const values = {};
  const failed = [];
  const done = [];
  for (const release of chosen) {
    const report = (fields) =>
      emit({ type: "progress", id: release.id, ...fields });
    if (signal.aborted) {
      report({ phase: "cancelled" });
      continue;
    }
    try {
      report({ phase: "start" });
      await installOne(root, release, signal, report);
      Object.assign(values, settingValues(root, release));
      done.push(release);
    } catch (cause) {
      const cancelled = signal.aborted;
      report({
        phase: cancelled ? "cancelled" : "failed",
        error: cancelled ? undefined : describe(cause),
      });
      if (!cancelled) failed.push(release.id);
    }
  }
  return { values, failed, done };
}

/**
 * Installs the chosen releases and saves their paths. An approved update is
 * pinned only once it is installed and in use; its older installs go then.
 */
async function installAndRecord({
  root,
  host,
  settings,
  chosen,
  overrides,
  signal,
  emit,
}) {
  const { values, failed, done } = await installEach(
    root,
    chosen,
    signal,
    emit,
  );
  const changed = Object.keys(values).length
    ? await settings.save(values)
    : false;
  const updated = done.filter((release) => overrides?.[release.id]);
  if (updated.length) {
    await savePins(
      root,
      host,
      updated.map((release) => ({ id: release.id, release })),
    );
    for (const release of updated) await pruneOlder(root, release);
  }
  return { values, failed, changed };
}

/** Built-in releases, with updates the user approved and any being installed. */
async function withPins(root, host, builtIn, overrides = {}) {
  const pins = await loadPins(root, host);
  return builtIn.map((release) => {
    if (overrides[release.id]) return { ...release, ...overrides[release.id] };
    // A pin only moves a provider forward from the built-in release.
    const pin = pins[release.id];
    return pin && compareVersions(pin.version, release.version) > 0
      ? { ...release, ...pin }
      : release;
  });
}

/** The chosen releases, plus Java when one needs it and REA has no Java home. */
function withJava(ids, components, releases) {
  const state = new Map(components.map((c) => [c.id, c]));
  const chosen = new Set(ids);
  for (const id of ids) {
    const needs = releases.find((release) => release.id === id)?.needs;
    const dependency = needs && state.get(needs);
    if (dependency && !chosen.has(needs) && !dependency.current.JAVA_HOME)
      chosen.add(needs);
  }
  return releases.filter((release) => chosen.has(release.id));
}

/** One release's plan entry, given the paths REA currently runs with. */
async function describeRelease(root, release, effective) {
  const here = await installed(root, release);
  const ours = settingValues(root, release);
  const inUse = Object.entries(ours).every(
    ([name, path]) => effective.get(name) === path,
  );
  const elsewhere = Object.keys(ours).some(
    (name) => effective.get(name) && effective.get(name) !== ours[name],
  );
  // ready: installed here and in use. available: installed here, but
  // REA points elsewhere or nowhere. configured: REA already points at
  // another copy. missing: nothing set.
  const state =
    here && inUse
      ? "ready"
      : here
        ? "available"
        : elsewhere
          ? "configured"
          : "missing";
  return {
    id: release.id,
    label: release.label,
    version: release.version,
    purpose: release.purpose,
    url: release.url,
    sha256: release.sha256,
    downloadBytes: here ? 0 : release.size,
    diskBytes: here ? 0 : release.diskBytes,
    needs: release.needs,
    destination: finalDir(root, release),
    settings: ours,
    current: Object.fromEntries(
      Object.keys(ours).map((name) => [name, effective.get(name) ?? ""]),
    ),
    state,
    recommended: state === "missing" || state === "available",
  };
}

/** Removes this workbench's older installs of a provider after an update. */
async function pruneOlder(root, release) {
  for (const name of await readdir(root).catch(() => [])) {
    const path = join(root, name);
    if (path === finalDir(root, release) || !name.startsWith(`${release.id}-`))
      continue;
    try {
      const marker = JSON.parse(await readFile(join(path, MARKER), "utf8"));
      if (marker.id === release.id)
        await rm(path, { recursive: true, force: true });
    } catch {
      // Not one of ours; leave it.
    }
  }
}

/**
 * @param {{ root: string, settings: ReturnType<import("./settings.mjs").createSettings>, env?: NodeJS.ProcessEnv }} options
 */
export function createInstaller({ root, settings, env = process.env }) {
  const host = `${process.platform}-${process.arch}`;
  const builtIn = RELEASES[host] ?? [];
  const byId = new Map(builtIn.map((release) => [release.id, release]));
  let job;

  const current = (overrides) => withPins(root, host, builtIn, overrides);

  async function plan() {
    const releases = await current();
    const effective = new Map(
      settings
        .describe(env)
        .settings.map((setting) => [setting.name, setting.effective]),
    );
    const components = await Promise.all(
      releases.map((release) => describeRelease(root, release, effective)),
    );
    return {
      root,
      host,
      supported: builtIn.length > 0,
      components,
      running: job?.snapshot(),
    };
  }

  async function expand(ids, overrides) {
    return withJava(ids, (await plan()).components, await current(overrides));
  }

  /**
   * Installs the chosen providers, then saves the paths of every one that
   * finished. `onEvent` receives progress.
   */
  async function install(ids, { onEvent = () => {}, signal, overrides } = {}) {
    for (const id of ids)
      if (!byId.has(id))
        throw new InstallError(
          `${id} is not a provider this workbench installs on ${host}.`,
        );
    if (job) throw new InstallError("An install is already running.");
    const controller = new AbortController();
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const progress = new Map();
    const emit = (event) => {
      if (event.id) progress.set(event.id, event);
      onEvent(event);
    };
    job = {
      cancel: () => controller.abort(),
      snapshot: () => ({ components: [...progress.values()] }),
    };
    try {
      await sweep(root);
      const chosen = await expand(ids, overrides);
      emit({ type: "plan", ids: chosen.map((release) => release.id) });
      const { values, failed, changed } = await installAndRecord({
        root,
        host,
        settings,
        chosen,
        overrides,
        signal: controller.signal,
        emit,
      });
      const result = {
        type: "done",
        changed,
        saved: Object.keys(values),
        failed,
        cancelled: controller.signal.aborted,
      };
      emit(result);
      return result;
    } finally {
      job = undefined;
    }
  }

  return {
    plan,
    /** The chosen ids plus any Java they need, in install order. */
    withDependencies: async (ids) =>
      (await expand(ids)).map((release) => release.id),
    install,

    /** Newer releases REA accepts; reaches upstream release metadata. */
    checkUpdates: async (options) =>
      findUpdates(host, await current(), options),

    /** Installs approved updates (from checkUpdates) like any provider. */
    applyUpdates: (updates, options = {}) =>
      install(
        updates.map(({ id }) => id),
        {
          ...options,
          overrides: Object.fromEntries(
            updates.map(({ id, release }) => [id, release]),
          ),
        },
      ),
    /** Cancels the running install; false when none is running. */
    cancel() {
      job?.cancel();
      return job !== undefined;
    },
    get running() {
      return job !== undefined;
    },
  };
}
