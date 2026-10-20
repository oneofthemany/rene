// Projects: one folder the user (or their agent) works in, with its own call
// history.
//
// The bridge owns a folder per project under --projects-dir. It holds
// project.json (the folder's path and identity) and history/ (the same store
// as history.mjs, one per project). Nothing is written into the project
// folder itself here; the assessment file is assessment.mjs's and needs the
// user's consent.
//
// A project is a folder, recognised by `sameFolder` below: the same real path
// and inode is the same folder, whatever the device number says, because
// device numbers aren't stable across reboots on btrfs and composefs (Fedora
// Atomic numbers them at mount). A path that now names a different folder
// (deleted and recreated) has another inode and is a new project, so its
// history never mixes with the old one. A folder moved within one boot keeps
// its project: device and inode find it and the recorded path is updated.

import { randomBytes } from "node:crypto";
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { createConversationStore } from "./conversations.mjs";
import { createHistory } from "./history.mjs";

const PROJECT_ID = /^[0-9a-f]{16}$/;

export class ProjectError extends Error {}

/** Where project stores live unless --projects-dir says otherwise. */
export const defaultProjectsDir = (env = process.env) =>
  join(
    env.XDG_DATA_HOME || join(homedir(), ".local/share"),
    "rea-workbench",
    "projects",
  );

/** The folder's real path and identity, or a refusal the page can show. */
async function identify(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new ProjectError("Choose a folder by its absolute path.");
  let real;
  try {
    real = await realpath(path);
  } catch {
    throw new ProjectError(`${path} doesn't exist.`);
  }
  const info = await stat(real);
  if (!info.isDirectory()) throw new ProjectError(`${real} is not a folder.`);
  // Device and inode are kept as strings: both can exceed 2^53.
  return { path: real, dev: String(info.dev), ino: String(info.ino) };
}

/**
 * How a stored project relates to a folder as it is now: "same" (same path
 * and inode), "moved" (same device and inode, another path), or undefined
 * (a different folder).
 */
function sameFolder(manifest, identity) {
  if (manifest.ino !== identity.ino) return undefined;
  if (manifest.path === identity.path) return "same";
  return manifest.dev === identity.dev ? "moved" : undefined;
}

/**
 * @param {string} root
 * @param {{ maxEntryBytes: number }} historyLimits
 */
export function createProjects(root, historyLimits) {
  const ready = mkdir(root, { recursive: true, mode: 0o700 });
  /** id -> { manifest, history } for projects opened since the bridge started. */
  const open = new Map();
  let queue = Promise.resolve();
  const serial = (work) => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };

  async function writeManifest(manifest) {
    const path = join(root, manifest.id, "project.json");
    await writeFile(`${path}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(`${path}.tmp`, path);
  }

  async function manifests() {
    await ready;
    const ids = (await readdir(root)).filter((name) => PROJECT_ID.test(name));
    const read = await Promise.all(
      ids.map((id) =>
        readFile(join(root, id, "project.json"), "utf8")
          .then((text) => JSON.parse(text))
          // A store without a readable manifest isn't listed; it is left alone.
          .catch(() => undefined),
      ),
    );
    return read.filter((manifest) => manifest && PROJECT_ID.test(manifest.id));
  }

  function attach(manifest) {
    const known = open.get(manifest.id);
    if (known) {
      known.manifest = manifest;
      return known;
    }
    const entry = {
      manifest,
      history: createHistory(join(root, manifest.id, "history"), historyLimits),
      conversations: createConversationStore(
        join(root, manifest.id, "conversations"),
      ),
    };
    open.set(manifest.id, entry);
    return entry;
  }

  /** Finds or creates the project for `path`. */
  const openPath = (path) =>
    serial(async () => {
      const identity = await identify(path);
      const all = await manifests();
      // The folder at its recorded path first, then one moved here; the
      // oldest wins, so a duplicate never takes over an existing history.
      const byAge = [...all].sort((a, b) => a.createdAt - b.createdAt);
      const found =
        byAge.find((manifest) => sameFolder(manifest, identity) === "same") ??
        byAge.find((manifest) => sameFolder(manifest, identity) === "moved");
      const now = Date.now();
      const manifest = found
        ? {
            ...found,
            path: identity.path,
            // Refreshed: the device number can change between boots.
            dev: identity.dev,
            lastUsedAt: now,
          }
        : {
            id: randomBytes(8).toString("hex"),
            ...identity,
            name: basename(identity.path) || identity.path,
            createdAt: now,
            lastUsedAt: now,
            assessment: "ask",
          };
      if (found && found.path !== identity.path)
        manifest.previousPaths = [
          ...new Set([...(found.previousPaths ?? []), found.path]),
        ];
      await mkdir(join(root, manifest.id), { recursive: true, mode: 0o700 });
      await writeManifest(manifest);
      return attach(manifest).manifest;
    });

  /** A project by id, if its store exists. */
  async function get(id) {
    if (typeof id !== "string" || !PROJECT_ID.test(id)) return undefined;
    const known = open.get(id);
    if (known) return known;
    const manifest = (await manifests()).find(
      (candidate) => candidate.id === id,
    );
    return manifest ? attach(manifest) : undefined;
  }

  return {
    openPath,
    get,

    /** Known projects, most recently used first, with whether the folder is still there. */
    async list() {
      const all = await manifests();
      const checked = await Promise.all(
        all.map(async (manifest) => {
          let present = "missing";
          try {
            const now = await identify(manifest.path);
            present = sameFolder(manifest, now) ? "present" : "replaced";
          } catch {
            // Missing or unreadable: reported as missing.
          }
          return { ...manifest, folder: present };
        }),
      );
      return checked.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
    },

    /** Changes stored project fields (the assessment choice). */
    update: (id, changes) =>
      serial(async () => {
        const entry = await get(id);
        if (!entry) throw new ProjectError("Unknown project.");
        const manifest = { ...entry.manifest, ...changes };
        await writeManifest(manifest);
        entry.manifest = manifest;
        return manifest;
      }),

    /** Closes every opened project's history store. */
    async close() {
      await Promise.allSettled(
        [...open.values()].map((entry) => entry.history.close()),
      );
    },

    /** The project's folder still has the identity it was recorded with. */
    async verify(entry) {
      const now = await identify(entry.manifest.path);
      if (!sameFolder(entry.manifest, now))
        throw new ProjectError(
          `${entry.manifest.path} is no longer the folder this project was made for. Open it again to start a new project there.`,
        );
      return now.path;
    },
  };
}
