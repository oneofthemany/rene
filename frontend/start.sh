#!/bin/bash
# Installs REA's locked dependencies when needed, builds the runtime, and
# starts the workbench UI. It never installs Node.js, npm, Java, or analysis
# providers; those are checked and reported with remediation instead.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install=true
build=true
open_browser=true
dry_run=false
server_args=()

usage() {
  cat <<'EOF'
Usage: frontend/start.sh [options] [-- bridge options]

Checks the Node.js toolchain, runs `npm ci` when installed dependencies do not
match package-lock.json, runs `npm run build:cached`, then starts the REA
workbench and opens it in your browser.

Options:
  --no-install   Never run npm ci; fail if dependencies are stale.
  --no-build     Skip npm run build:cached.
  --no-open      Print the URL instead of opening a browser.
  --dry-run      Show the planned steps without running them.
  -h, --help     Show this help.

Bridge options after `--` are passed to frontend/server.mjs, for example:
  frontend/start.sh -- --port 0 --max-concurrent 2
EOF
}

fail() {
  printf 'REA workbench: %s\n' "$1" >&2
  exit 1
}

while (($# > 0)); do
  case "$1" in
    --no-install) install=false ;;
    --no-build) build=false ;;
    --no-open) open_browser=false ;;
    --dry-run) dry_run=true ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      shift
      server_args=("$@")
      break
      ;;
    *) fail "unknown option: $1 (see --help)" ;;
  esac
  shift
done

cd "$repo_root"

# --- Toolchain: checked, never installed ---------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js is required. Install the version in .nvmrc ($(cat .nvmrc)), for example with \`nvm install && nvm use\`, then retry."
command -v npm >/dev/null 2>&1 || fail "npm is required; it ships with Node.js."

# package.json#engines.node is the owner of the supported range.
node_check="$(
  node -e '
    const range = require("./package.json").engines?.node ?? "";
    const parse = (v) => v.split(".").map(Number);
    const [major, minor, patch] = parse(process.versions.node);
    const satisfies = (clause) => {
      const m = /^(\^|>=)(\d+)\.(\d+)\.(\d+)$/.exec(clause.trim());
      if (!m) return undefined;
      const [want, op] = [[+m[2], +m[3], +m[4]], m[1]];
      const atLeast = major !== want[0] ? major > want[0]
        : minor !== want[1] ? minor > want[1] : patch >= want[2];
      return op === ">=" ? atLeast : atLeast && major === want[0];
    };
    const results = range.split("||").map(satisfies);
    if (results.includes(undefined)) console.log(`unknown ${range}`);
    else console.log(results.some(Boolean) ? "ok" : `unsupported ${range}`);
  '
)"
case "$node_check" in
  ok) ;;
  unsupported*)
    fail "Node.js $(node -v) does not satisfy \"${node_check#unsupported }\". Switch with \`nvm install && nvm use\` (uses .nvmrc: $(cat .nvmrc)), then retry."
    ;;
  *) printf 'Note: could not interpret engines range "%s"; npm will enforce it.\n' "${node_check#unknown }" ;;
esac

wanted_npm="$(node -p 'require("./package.json").packageManager?.replace(/^npm@/, "") ?? ""')"
if [ -n "$wanted_npm" ] && [ "$(npm -v)" != "$wanted_npm" ]; then
  printf 'Note: npm %s is active; this repository pins npm %s (package.json#packageManager).\n' "$(npm -v)" "$wanted_npm"
fi

# --- Plan ----------------------------------------------------------------
steps=()
if ! node scripts/check-dependency-install.mjs 2>/dev/null; then
  [ "$install" = true ] || fail "installed dependencies do not match package-lock.json. Run npm ci, or rerun without --no-install."
  steps+=("npm ci")
fi
[ "$build" = true ] && steps+=("npm run build:cached")

launch=(node frontend/server.mjs)
[ "$open_browser" = true ] && launch+=(--open)
launch+=(${server_args[@]+"${server_args[@]}"})

printf 'Node.js %s, npm %s\n' "$(node -v)" "$(npm -v)"
printf 'Plan:\n'
for step in ${steps[@]+"${steps[@]}"}; do printf '  %s\n' "$step"; done
printf '  %s\n' "${launch[*]}"
[ "$dry_run" = true ] && exit 0

# --- Run -----------------------------------------------------------------
for step in ${steps[@]+"${steps[@]}"}; do
  printf '\n==> %s\n' "$step"
  # shellcheck disable=SC2086 # steps are fixed literals above
  $step
done

printf '\n==> Starting the workbench (Ctrl+C to stop)\n'
printf 'Analysis providers (Ghidra, IDA, Hopper, ...) are bring-your-own; see README.md for setup.\n'
exec "${launch[@]}"
