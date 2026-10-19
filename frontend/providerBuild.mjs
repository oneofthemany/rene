// Builds one provider or tool into a staging folder.
//
// Downloads must match their pinned size and SHA-256. Python tools are built
// with uv into a relocatable virtual environment, from pinned package
// versions that uv checks against the index's hashes; their interpreter is a
// uv-managed Python kept in <providers>/python. Generated launchers locate
// their own folder at run time, so the staging folder can be renamed into
// place. Each build ends with the release's own version check.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const MiB = 1024 * 1024;

export class BuildError extends Error {}

const describe = (cause) =>
  cause instanceof Error ? cause.message : String(cause);

/** What identifies an install: the archive digest, or the Python recipe. */
export const fingerprint = (release) =>
  release.kind === "python"
    ? JSON.stringify({
        python: release.python,
        packages: release.packages,
        extras: (release.extras ?? []).map((extra) => extra.sha256),
      })
    : release.sha256;

/** Downloads `source` (url, size, sha256, label) to `file`, checking both. */
export async function download(source, file, signal, report) {
  const response = await fetch(source.url, { signal, redirect: "follow" });
  if (!response.ok || !response.body)
    throw new BuildError(
      `${source.label}: download failed with HTTP ${response.status}.`,
    );
  const hash = createHash("sha256");
  let received = 0;
  let reported = 0;
  const counted = Readable.fromWeb(response.body).map(
    (chunk) => {
      received += chunk.length;
      if (received > source.size)
        throw new BuildError(
          `${source.label}: the download is larger than the pinned ${source.size} bytes.`,
        );
      hash.update(chunk);
      if (
        received - reported >= source.size / 100 ||
        received === source.size
      ) {
        reported = received;
        report({ phase: "download", received, total: source.size });
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
  if (received !== source.size || digest !== source.sha256)
    throw new BuildError(
      `${source.label}: the download does not match the pinned release (got ${received} bytes, SHA-256 ${digest}). Nothing was installed.`,
    );
}

async function tool(command, args, options, label) {
  try {
    return await run(command, args, { maxBuffer: 16 * MiB, ...options });
  } catch (cause) {
    if (cause.code === "ENOENT")
      throw new BuildError(`${label}: ${command} is needed and wasn't found.`);
    throw new BuildError(
      `${label}: ${command} failed: ${(cause.stderr || describe(cause)).trim().slice(-2000)}`,
    );
  }
}

const UNPACK = {
  zip: (file, target) => ["unzip", ["-q", file, "-d", target]],
  "tar.gz": (file, target) => [
    "tar",
    ["-xzf", file, "-C", target, "--no-same-owner"],
  ],
  "tar.xz": (file, target) => [
    "tar",
    ["-xJf", file, "-C", target, "--no-same-owner"],
  ],
};

/** Unpacks an archive and returns its single top-level folder. */
async function unpack(release, file, staging, signal) {
  const target = join(staging, "unpacked");
  await mkdir(target);
  // tar and unzip refuse absolute and ../ member names by default.
  const [command, args] = UNPACK[release.archive](file, target);
  await tool(command, args, { signal }, release.label);
  const entries = await readdir(target, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0].isDirectory())
    throw new BuildError(
      `${release.label}: expected one top-level folder in the archive, found ${entries.length} entries.`,
    );
  return join(target, entries[0].name);
}

/** Members of a Debian package's data archive, copied to `content`. */
async function extractDeb(extra, file, { staging, content, signal }) {
  const bytes = await readFile(file);
  if (bytes.subarray(0, 8).toString("latin1") !== "!<arch>\n")
    throw new BuildError(`${extra.label}: not a Debian package.`);
  let offset = 8;
  let data;
  while (offset + 60 <= bytes.length) {
    const name = bytes
      .subarray(offset, offset + 16)
      .toString("latin1")
      .trim();
    const size = Number.parseInt(
      bytes.subarray(offset + 48, offset + 58).toString("latin1"),
      10,
    );
    if (name.startsWith("data.tar"))
      data = { name: name.replace(/\/$/, ""), start: offset + 60, size };
    offset += 60 + size + (size % 2);
  }
  if (!data) throw new BuildError(`${extra.label}: no data archive inside.`);
  const tarFile = join(staging, data.name);
  await writeFile(tarFile, bytes.subarray(data.start, data.start + data.size));
  const target = join(staging, `${extra.id}-unpacked`);
  await mkdir(target);
  await tool(
    "tar",
    ["-xf", tarFile, "-C", target, "--no-same-owner"],
    { signal },
    extra.label,
  );
  for (const [member, destination] of Object.entries(extra.members)) {
    await mkdir(dirname(join(content, destination)), { recursive: true });
    await copyFile(join(target, member), join(content, destination));
    await chmod(join(content, destination), 0o755);
  }
}

async function buildPython(release, content, { root, signal, report }) {
  const env = {
    ...process.env,
    // The interpreter belongs to the providers folder, not the user's uv.
    UV_PYTHON_INSTALL_DIR: join(root, "python"),
    UV_NO_CONFIG: "1",
  };
  const venv = join(content, "venv");
  report({ phase: "build" });
  await tool(
    "uv",
    [
      "venv",
      "--quiet",
      "--relocatable",
      "--managed-python",
      "--python",
      release.python,
      venv,
    ],
    { env, signal },
    release.label,
  );
  await tool(
    "uv",
    [
      "pip",
      "install",
      "--quiet",
      "--python",
      join(venv, "bin/python"),
      ...release.packages,
    ],
    { env, signal, timeout: 15 * 60_000 },
    release.label,
  );
}

/**
 * Builds the release into a folder under `staging` and returns it. The
 * folder becomes the install when the caller renames it into place.
 */
export async function buildContent(release, staging, { root, signal, report }) {
  let content;
  if (release.kind === "python") {
    content = join(staging, "content");
    await mkdir(content);
    await buildPython(release, content, { root, signal, report });
  } else {
    const file = join(staging, "download");
    await download(release, file, signal, report);
    report({ phase: "unpack" });
    if (release.archive === "file") {
      content = join(staging, "content");
      await mkdir(content);
      await rename(file, join(content, release.fileName));
    } else content = await unpack(release, file, staging, signal);
  }
  for (const extra of release.extras ?? []) {
    const file = join(staging, `${extra.id}.download`);
    await download(extra, file, signal, report);
    await extractDeb(extra, file, { staging, content, signal });
  }
  for (const [name, script] of Object.entries(release.launchers ?? {})) {
    await writeFile(join(content, name), script, { mode: 0o755 });
  }
  return content;
}

/** Runs the release's version check; its output must match `expect`. */
export async function verifyContent(release, content, env, signal) {
  if (!release.check) return;
  const [command, ...args] = release.check.command;
  // Relative paths in a check are inside the install; absolute ones aren't.
  const checkEnv = Object.fromEntries(
    Object.entries(release.check.env ?? {}).map(([name, value]) => [
      name,
      resolve(content, value),
    ]),
  );
  const { stdout, stderr } = await tool(
    resolve(content, command),
    args,
    { env: { ...env, ...checkEnv }, signal, timeout: 120_000, cwd: content },
    release.label,
  );
  const output = `${stdout}\n${stderr}`;
  if (!release.check.expect.test(output))
    throw new BuildError(
      `${release.label}: the installed tool reported ${JSON.stringify(output.trim().slice(0, 300))}, not the expected version.`,
    );
}
