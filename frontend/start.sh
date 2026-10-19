#!/bin/bash
# Stops a workbench this script started earlier, installs REA's locked
# dependencies when needed, rebuilds the runtime, offers to download the
# analysis providers and tools REA is missing (pinned and checksum-verified,
# into a user-owned folder), builds and starts the `rene` podman container
# that runs REA with its system tools (Hopper, binwalk, gdb, ...), and starts
# the workbench UI. It never installs Node.js or npm, never changes the host
# system, and never uses administrator access.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install=true
build=true
providers=ask
container=true
rebuild_container=false
open_browser=true
dry_run=false
stop_only=false
server_args=()
pid_file="$repo_root/frontend/.workbench.pid"
stop_timeout_s=15

usage() {
  cat <<'EOF'
Usage: frontend/start.sh [options] [-- bridge options]

Stops the workbench this script started earlier (if it is still running),
checks the Node.js toolchain, runs `npm ci` when installed dependencies do not
match package-lock.json, runs `npm run build:cached`, offers to download the
analysis providers and tools REA is missing (frontend/install-providers.mjs),
builds the REA container image when its recipe changed (asks first), starts
the `rene` container, then starts the REA workbench and opens it in your
browser. REA runs inside the container (frontend/container/rea).

Options:
  --no-install   Never run npm ci; fail if dependencies are stale.
  --no-build     Skip npm run build:cached.
  --install-providers
                 Download missing providers without asking.
  --no-providers Don't offer to download providers and tools.
  --rebuild-container
                 Rebuild the container image even if its recipe is unchanged
                 (for example to pick up Fedora updates or a new Hopper).
  --no-container Run REA directly on the host instead of in the container.
  --no-open      Print the URL instead of opening a browser.
  --dry-run      Show the planned steps without running them.
  --stop         Stop the running workbench and exit.
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
    --install-providers) providers=yes ;;
    --no-providers) providers=skip ;;
    --rebuild-container) rebuild_container=true ;;
    --no-container) container=false ;;
    --no-open) open_browser=false ;;
    --dry-run) dry_run=true ;;
    --stop) stop_only=true ;;
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

# --- Previous workbench --------------------------------------------------
# The pid file holds the pid and that process's start time. A pid alone can
# be reused after exit, so a process is ours only while both still match and
# it is running frontend/server.mjs.

process_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }

is_our_workbench() {
  local pid="$1" started="$2"
  [ -n "$started" ] && [ "$(process_start "$pid")" = "$started" ] || return 1
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *frontend/server.mjs*) return 0 ;;
    *) return 1 ;;
  esac
}

previous_pid=""
previous_started=""
if [ -f "$pid_file" ]; then
  { IFS= read -r previous_pid && IFS= read -r previous_started; } <"$pid_file" || true
  if ! [[ "$previous_pid" =~ ^[0-9]+$ ]] || ! is_our_workbench "$previous_pid" "$previous_started"; then
    previous_pid=""
  fi
fi

# Stops the recorded workbench: SIGTERM lets it close REA's MCP child and
# remove its pid file; SIGKILL only if it is still the same process later.
stop_previous() {
  if [ -z "$previous_pid" ]; then
    if [ -f "$pid_file" ]; then
      printf 'Removing a stale pid file; its process is no longer the workbench.\n'
      rm -f "$pid_file"
    fi
    return 0
  fi
  printf '\n==> Stopping the running workbench (pid %s)\n' "$previous_pid"
  kill -TERM "$previous_pid" 2>/dev/null || true
  local waited=0
  while is_our_workbench "$previous_pid" "$previous_started"; do
    if ((waited >= stop_timeout_s * 4)); then
      printf 'Still running after %s s; sending SIGKILL.\n' "$stop_timeout_s"
      kill -KILL "$previous_pid" 2>/dev/null || true
      sleep 1
      ! is_our_workbench "$previous_pid" "$previous_started" || fail "could not stop pid $previous_pid."
      break
    fi
    sleep 0.25
    waited=$((waited + 1))
  done
  rm -f "$pid_file"
  printf 'Stopped.\n'
}

if [ "$stop_only" = true ]; then
  if [ "$dry_run" = true ]; then
    if [ -n "$previous_pid" ]; then
      printf 'Plan:\n  stop the running workbench (pid %s)\n' "$previous_pid"
    else
      printf 'Plan:\n  nothing to stop\n'
    fi
    exit 0
  fi
  [ -n "$previous_pid" ] || printf 'No workbench started by this script is running.\n'
  stop_previous
  exit 0
fi

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
# The page's own packages (the xterm.js terminal) live in frontend/package.json.
# npm records what it installed in node_modules/.package-lock.json.
if ! node -e '
  const { readFileSync } = require("node:fs");
  const read = (path) => JSON.parse(readFileSync(path, "utf8")).packages ?? {};
  const want = read("frontend/package-lock.json");
  const have = read("frontend/node_modules/.package-lock.json");
  const ok = Object.entries(want).every(([path, entry]) =>
    path === "" || have[path]?.version === entry.version);
  process.exit(ok ? 0 : 1);
' 2>/dev/null; then
  [ "$install" = true ] || fail "the workbench page's packages are missing or stale. Run npm ci --prefix frontend, or rerun without --no-install."
  steps+=("npm ci --prefix frontend")
fi
[ "$build" = true ] && steps+=("npm run build:cached")

launch=(node frontend/server.mjs)
[ "$open_browser" = true ] && launch+=(--open)
launch+=(--pid-file "$pid_file" ${server_args[@]+"${server_args[@]}"})

printf 'Node.js %s, npm %s\n' "$(node -v)" "$(npm -v)"
printf 'Plan:\n'
[ -n "$previous_pid" ] && printf '  stop the running workbench (pid %s)\n' "$previous_pid"
for step in ${steps[@]+"${steps[@]}"}; do printf '  %s\n' "$step"; done
provider_install=(node frontend/install-providers.mjs)
[ "$providers" = yes ] && provider_install+=(--yes)
case "$providers" in
  ask) printf '  %s (asks before downloading)\n' "${provider_install[*]}" ;;
  yes) printf '  %s\n' "${provider_install[*]}" ;;
esac
container_script="$repo_root/frontend/container/container.sh"
if [ "$container" = true ]; then
  image_state="$("$container_script" image-state)"
  if [ "$rebuild_container" = true ] || [ "$image_state" != current ]; then
    printf '  %s build (image is %s; asks before building)\n' "$container_script" "$image_state"
  fi
  printf '  %s ensure (start the rene container)\n' "$container_script"
  launch+=(--rea "$repo_root/frontend/container/rea")
fi
printf '  %s\n' "${launch[*]}"
if [ "$dry_run" = true ]; then
  [ "$providers" = skip ] || { printf '\n'; node frontend/install-providers.mjs --dry-run; }
  exit 0
fi

# --- Run -----------------------------------------------------------------
# Stop first: the build rewrites dist/, which a running bridge loads from.
stop_previous

for step in ${steps[@]+"${steps[@]}"}; do
  printf '\n==> %s\n' "$step"
  # shellcheck disable=SC2086 # steps are fixed literals above
  $step
done

if [ "$providers" != skip ]; then
  printf '\n==> Analysis providers\n'
  # A failed or declined download leaves REA usable; the Providers page can retry.
  "${provider_install[@]}" || printf 'Some providers were not installed; the workbench starts anyway. Retry from its Providers page.\n'
fi

if [ "$container" = true ]; then
  printf '\n==> REA container\n'
  if [ "$rebuild_container" = true ] || [ "$image_state" != current ]; then
    build_args=(build)
    [ "$providers" = yes ] && build_args+=(--yes)
    if ! "$container_script" "${build_args[@]}"; then
      if [ "$image_state" = missing ]; then
        printf 'No container image; REA runs on the host without its system tools.\n'
        container=false
        launch=(node frontend/server.mjs)
        [ "$open_browser" = true ] && launch+=(--open)
        launch+=(--pid-file "$pid_file" ${server_args[@]+"${server_args[@]}"})
      else
        printf 'Keeping the existing container image.\n'
      fi
    fi
  fi
  [ "$container" = true ] && "$container_script" ensure
fi

printf '\n==> Starting the workbench (Ctrl+C to stop)\n'
# exec keeps this pid and start time, so the record identifies the bridge.
printf '%s\n%s\n' "$$" "$(process_start $$)" >"$pid_file.tmp"
mv "$pid_file.tmp" "$pid_file"
exec "${launch[@]}"
