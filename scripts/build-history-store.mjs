// Builds rene-history (packages/history-store), the workbench's DuckDB
// history store, into packages/history-store/dist/rene-history.
//
// The same approach as sherloq's appender build. A content fingerprint (the
// crate's sources and Cargo files, the rustc version and how DuckDB is
// linked) decides whether dist/ is current; when it is, nothing is compiled.
// When it isn't, cargo builds offline through the crate's target/ folder, so
// only changed code recompiles.
//
// DuckDB itself comes from a cache of its compiled static library, keyed by
// the libduckdb-sys version in Cargo.lock:
// ${RENE_DUCKDB_CACHE:-~/.cache/rene/duckdb/<version>}/{lib/libduckdb_static.a,include/duckdb.h}.
// When the cache has it, it is linked (seconds). When not, DuckDB compiles
// from source (a few minutes) and the library it produced is cached for the
// next build. Nothing is downloaded: crates come from cargo's local cache,
// and a missing crate fails the build with a message.
//
//   node scripts/build-history-store.mjs           build if stale
//   node scripts/build-history-store.mjs --force   rebuild anyway
//   node scripts/build-history-store.mjs --check   exit 0 if current, 1 if stale

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "packages", "history-store");
const dist = join(crate, "dist");
const binary = join(dist, "rene-history");
const stamp = join(dist, ".fingerprint");
const force = process.argv.includes("--force");
const check = process.argv.includes("--check");

const fail = (message) => {
  console.error(`history-store: ${message}`);
  process.exit(1);
};

const lock = readFileSync(join(crate, "Cargo.lock"), "utf8");
const duckdbVersion = /name = "libduckdb-sys"\nversion = "([^"]+)"/.exec(
  lock,
)?.[1];
if (!duckdbVersion) fail("Cargo.lock names no libduckdb-sys version.");
const cache =
  process.env.RENE_DUCKDB_CACHE ??
  join(homedir(), ".cache", "rene", "duckdb", duckdbVersion);
const cachedLib = join(cache, "lib", "libduckdb_static.a");
const cachedHeader = join(cache, "include", "duckdb.h");
const linked = existsSync(cachedLib) && existsSync(cachedHeader);

const rustc = spawnSync("rustc", ["-vV"], { encoding: "utf8" });
const toolchain = rustc.status === 0 ? rustc.stdout : undefined;

/** Every file under a folder, sorted, as paths relative to the crate. */
const filesUnder = (folder) =>
  readdirSync(folder, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(crate, join(entry.parentPath, entry.name)))
    .sort();

const sha256 = (...parts) => {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest("hex");
};
// The sources alone, and the whole build (sources, toolchain, DuckDB link).
const sources = sha256(
  ...[
    "Cargo.toml",
    "Cargo.lock",
    "build.rs",
    ...filesUnder(join(crate, "src")),
  ].flatMap((file) => [`${file}\0`, readFileSync(join(crate, file))]),
);
const current =
  toolchain &&
  sha256(
    sources,
    toolchain,
    `duckdb ${duckdbVersion} ${linked ? "linked" : "bundled"}`,
  );

// The stamp holds the sources hash, then the whole-build hash.
const [stampedSources, stampedBuild] = existsSync(stamp)
  ? readFileSync(stamp, "utf8").trim().split("\n")
  : [];
if (existsSync(binary) && !force) {
  if (current && stampedBuild === current) {
    console.log("history-store: dist/rene-history is current; reusing it.");
    process.exit(0);
  }
  // Without a Rust toolchain here (a host that builds inside the rene
  // container, say), a binary built from these same sources is still current.
  if (!toolchain && stampedSources === sources) {
    console.log(
      "history-store: no rustc here; dist/rene-history was built from these sources, reusing it.",
    );
    process.exit(0);
  }
}
if (!toolchain)
  fail(
    "dist/rene-history is missing or stale, and rustc was not found; install Rust (cargo and rustc), or build it where Rust is installed with `npm run history-store:build`.",
  );
if (check) {
  console.log(
    existsSync(binary)
      ? "history-store: dist/rene-history is stale."
      : "history-store: dist/rene-history has not been built.",
  );
  process.exit(1);
}

console.log(
  linked
    ? `history-store: building, linking DuckDB ${duckdbVersion} from ${cache}.`
    : `history-store: building; no cached DuckDB ${duckdbVersion}, so it compiles from source (a few minutes) and is cached in ${cache}.`,
);
const args = ["build", "--release", "--offline", "--locked"];
if (!linked) args.push("--features", "bundled");
const env = { ...process.env };
if (linked)
  Object.assign(env, {
    DUCKDB_LIB_DIR: dirname(cachedLib),
    DUCKDB_INCLUDE_DIR: dirname(cachedHeader),
    DUCKDB_STATIC: "1",
  });
const build = spawnSync("cargo", args, { cwd: crate, env, stdio: "inherit" });
if (build.status !== 0)
  fail(
    `cargo ${args.join(" ")} failed (status ${build.status ?? build.signal}). ` +
      "If a crate is missing from cargo's local cache, fetch it yourself with `cargo fetch` in packages/history-store, then retry.",
  );

/** Copies a file into place through a temporary name, so readers never see half of it. */
const place = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, `${to}.tmp`);
  renameSync(`${to}.tmp`, to);
};

if (!linked) {
  // The bundled build leaves its static library in libduckdb-sys's OUT_DIR;
  // the newest one is this build's.
  const builds = join(crate, "target", "release", "build");
  const out = readdirSync(builds)
    .filter((name) => name.startsWith("libduckdb-sys-"))
    .map((name) => join(builds, name, "out"))
    .filter((dir) => existsSync(join(dir, "libduckdb.a")))
    .sort(
      (a, b) =>
        statSync(join(b, "libduckdb.a")).mtimeMs -
        statSync(join(a, "libduckdb.a")).mtimeMs,
    )[0];
  if (out) {
    place(join(out, "libduckdb.a"), cachedLib);
    place(join(out, "duckdb", "src", "include", "duckdb.h"), cachedHeader);
    console.log(`history-store: cached DuckDB ${duckdbVersion} in ${cache}.`);
  } else
    console.warn(
      "history-store: the bundled build left no libduckdb.a to cache.",
    );
}

place(join(crate, "target", "release", "rene-history"), binary);
// The fingerprint describes the build that produced dist/, so it is taken
// before any cache it filled changes how the next build links.
writeFileSync(stamp, `${sources}\n${current}\n`);
console.log("history-store: built dist/rene-history.");
