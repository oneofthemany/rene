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
import { randomBytes } from "node:crypto";
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
import { buildContent, fingerprint, verifyContent } from "./providerBuild.mjs";
import { releaseWanted } from "./choices.mjs";
import { RELEASES } from "./providerReleases.mjs";
import {
  compareVersions,
  findUpdates,
  loadPins,
  savePins,
} from "./providerUpdates.mjs";

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
    // Installs from before fingerprints recorded only the archive digest.
    if ((marker.fingerprint ?? marker.sha256) !== fingerprint(release))
      return false;
    for (const path of Object.values(settingValues(root, release)))
      await stat(path);
    return true;
  } catch {
    return false;
  }
}

const writeMarker = (dir, release) =>
  writeFile(
    join(dir, MARKER),
    `${JSON.stringify(
      {
        id: release.id,
        version: release.version,
        url: release.url,
        fingerprint: fingerprint(release),
        installedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

/**
 * Moves a built folder into place. A folder already there is kept when it
 * is a complete install of this release.
 */
async function publish(root, release, content) {
  const final = finalDir(root, release);
  try {
    await rename(content, final);
    return true;
  } catch (cause) {
    if (await installed(root, release)) return false;
    throw new InstallError(
      `${release.label}: ${final} already exists and is not a complete install from this workbench. Move it aside and retry.`,
      { cause },
    );
  }
}

async function stage(root, release) {
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
  return staging;
}

async function installOne(root, release, { signal, report, env }) {
  if (await installed(root, release)) {
    report({ phase: "present" });
    return;
  }
  const staging = await stage(root, release);
  try {
    const content = await buildContent(release, staging, {
      root,
      signal,
      report,
    });
    report({ phase: "check" });
    await verifyContent(release, content, env, signal);
    await writeMarker(content, release);
    signal.throwIfAborted();
    await publish(root, release, content);
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
async function installEach(root, chosen, { signal, emit, env }) {
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
      // Checks see the paths installed so far, such as Java for Apktool.
      await installOne(root, release, {
        signal,
        report,
        env: { ...env, ...values },
      });
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
  const { values, failed, done } = await installEach(root, chosen, {
    signal,
    emit,
    env: settings.environment(process.env),
  });
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
async function describeRelease(root, release, { effective, uvAvailable }) {
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
    group: release.group ?? "provider",
    kind: release.kind ?? "download",
    label: release.label,
    version: release.version,
    purpose: release.purpose,
    url: release.url,
    sha256: release.sha256,
    packages: release.packages,
    extras: (release.extras ?? []).map(({ label, url, sha256 }) => ({
      label,
      url,
      sha256,
    })),
    blocked: here ? undefined : blockedBy(release, uvAvailable),
    downloadBytes: here ? 0 : release.size,
    diskBytes: here ? 0 : release.diskBytes,
    needs: release.needs,
    destination: finalDir(root, release),
    settings: ours,
    current: Object.fromEntries(
      Object.keys(ours).map((name) => [name, effective.get(name) ?? ""]),
    ),
    state,
    recommended:
      (state === "missing" || state === "available") &&
      (here || !blockedBy(release, uvAvailable)),
  };
}

/** Why a release can't be installed yet, if it can't. */
function blockedBy(release, uvAvailable) {
  // uv builds the Python tools; the workbench doesn't install it.
  if (release.kind === "python" && !uvAvailable)
    return "Needs uv (https://docs.astral.sh/uv/) on PATH.";
  return undefined;
}

/** Whether uv runs; Python tools need it. */
const uvRuns = () =>
  new Promise((resolvePromise) =>
    execFile("uv", ["--version"], { timeout: 10_000 }, (error) =>
      resolvePromise(!error),
    ),
  );

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
    const [releases, uvAvailable] = await Promise.all([current(), uvRuns()]);
    const effective = new Map(
      settings
        .describe(env)
        .settings.map((setting) => [setting.name, setting.effective]),
    );
    const use = settings.use();
    const components = (
      await Promise.all(
        releases.map((release) =>
          describeRelease(root, release, { effective, uvAvailable }),
        ),
      )
    ).map((component, index) => {
      // Releases for things the user turned off are listed, not offered.
      const used = releaseWanted(releases[index], releases, use);
      return {
        ...component,
        used,
        recommended: component.recommended && used,
      };
    });
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
