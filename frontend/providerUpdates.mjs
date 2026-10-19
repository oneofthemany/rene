// Update checks for downloaded providers.
//
// Only releases REA accepts are offered: Java 21 patch releases, Ghidra
// 12.1.x and DuckDB 1.x (a database can only be read by a DuckDB at least as
// new as its writer). JADX and Kuna stay on the versions REA pins and
// verified. The
// upstream release metadata supplies each candidate's size and SHA-256; a
// release the user approves is recorded in <providers>/pins.json, which then
// replaces the built-in pin and is checked like it on download.

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const SHA256 = /^[0-9a-f]{64}$/;
const CHECK_TIMEOUT_MS = 15_000;

/** Numeric version order; "12.1" sorts before "12.1.4". */
export function compareVersions(left, right) {
  const parts = (version) =>
    version.split(/[.+_-]/).map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function getJson(url, signal) {
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json", "user-agent": "rea-workbench" },
  });
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}.`);
  return response.json();
}

/** Latest Temurin 21 JDK for this architecture. */
async function latestJdk(host, signal) {
  const architecture = host === "linux-arm64" ? "aarch64" : "x64";
  const [asset] = await getJson(
    `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${architecture}&image_type=jdk&os=linux&vendor=eclipse`,
    signal,
  );
  const binary = asset?.binary?.package;
  if (!binary) return undefined;
  return {
    version: asset.release_name.replace(/^jdk-/, ""),
    url: binary.link,
    sha256: binary.checksum,
    size: binary.size,
  };
}

/** Newest Ghidra 12.1.x; REA accepts only that line. */
async function latestGhidra(_host, signal) {
  const releases = await getJson(
    "https://api.github.com/repos/NationalSecurityAgency/ghidra/releases?per_page=20",
    signal,
  );
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => {
      const version = /^Ghidra_(12\.1(?:\.\d+)?)_build$/.exec(
        release.tag_name,
      )?.[1];
      const asset = release.assets?.find((candidate) =>
        /^ghidra_[\d.]+_PUBLIC_\d+\.zip$/.test(candidate.name),
      );
      const sha256 = asset?.digest?.replace(/^sha256:/, "");
      return version && asset && sha256
        ? { version, url: asset.browser_download_url, sha256, size: asset.size }
        : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0];
}

/** Newest DuckDB 1.x CLI for this architecture; REA accepts only 1.x. */
async function latestDuckdb(host, signal) {
  const architecture = host === "linux-arm64" ? "arm64" : "amd64";
  const releases = await getJson(
    "https://api.github.com/repos/duckdb/duckdb/releases?per_page=20",
    signal,
  );
  const candidates = releases
    .filter((release) => !release.draft && !release.prerelease)
    .map((release) => {
      const version = /^v(1\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
      const asset = release.assets?.find(
        (candidate) =>
          candidate.name === `duckdb_cli-linux-${architecture}.zip`,
      );
      const sha256 = asset?.digest?.replace(/^sha256:/, "");
      return version && asset && sha256
        ? { version, url: asset.browser_download_url, sha256, size: asset.size }
        : undefined;
    })
    .filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version));
  return candidates[0];
}

const SOURCES = { jdk: latestJdk, ghidra: latestGhidra, duckdb: latestDuckdb };

/** A pin is usable only with an https URL, a SHA-256 and a positive size. */
const validPin = (pin) =>
  typeof pin?.version === "string" &&
  typeof pin.url === "string" &&
  pin.url.startsWith("https://") &&
  typeof pin.sha256 === "string" &&
  SHA256.test(pin.sha256) &&
  Number.isSafeInteger(pin.size) &&
  pin.size > 0;

/** Approved pins for this host; a damaged file pins nothing. */
export async function loadPins(root, host) {
  try {
    const stored = JSON.parse(await readFile(join(root, "pins.json"), "utf8"));
    const pins = stored?.hosts?.[host] ?? {};
    return Object.fromEntries(
      Object.entries(pins).filter(
        ([id, pin]) => id in SOURCES && validPin(pin),
      ),
    );
  } catch {
    return {};
  }
}

/** Records approved releases, replacing earlier pins for the same providers. */
export async function savePins(root, host, updates) {
  let stored = {};
  try {
    stored = JSON.parse(await readFile(join(root, "pins.json"), "utf8"));
  } catch {
    stored = {};
  }
  const hosts = { ...stored.hosts };
  hosts[host] = { ...hosts[host] };
  for (const { id, release } of updates)
    hosts[host][id] = {
      version: release.version,
      url: release.url,
      sha256: release.sha256,
      size: release.size,
    };
  const path = join(root, "pins.json");
  await writeFile(`${path}.tmp`, `${JSON.stringify({ hosts }, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

/**
 * Newer accepted releases for the current pins. A source that can't be
 * reached is reported in `unchecked` rather than treated as up to date.
 */
export async function findUpdates(host, releases, { signal } = {}) {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const updates = [];
  const unchecked = [];
  await Promise.all(
    releases
      .filter((release) => release.id in SOURCES)
      .map(async (release) => {
        try {
          const latest = await SOURCES[release.id](host, combined);
          if (
            latest &&
            validPin(latest) &&
            compareVersions(latest.version, release.version) > 0
          )
            updates.push({
              id: release.id,
              label: release.label,
              from: release.version,
              to: latest.version,
              release: latest,
            });
        } catch (cause) {
          unchecked.push({
            id: release.id,
            label: release.label,
            reason: cause.message,
          });
        }
      }),
  );
  return { updates, unchecked };
}
