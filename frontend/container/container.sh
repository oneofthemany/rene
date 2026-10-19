#!/bin/bash
# Builds and runs the `rene` podman container that hosts REA's system tools.
#
#   container.sh status          image and container state
#   container.sh build [--yes]   build the image (asks first unless --yes)
#   container.sh ensure          create or start the container from the image
#   container.sh stop            stop the container
#   container.sh shell           open a shell in the container
#
# The image is rebuilt only when its recipe (this folder's Containerfile and
# hopper-install.mjs) changes. The container runs as your user ID with your
# home folder mounted at the same path, so paths, settings and the tools the
# workbench installs under ~/.local/share work unchanged inside it.
set -euo pipefail

here="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
image="${REA_CONTAINER_IMAGE:-localhost/rene:latest}"
name="${REA_CONTAINER_NAME:-rene}"

fail() {
  printf 'REA container: %s\n' "$1" >&2
  exit 1
}

command -v podman >/dev/null 2>&1 || fail "podman is required."

recipe_hash() {
  cat "$here/Containerfile" "$here/hopper-install.mjs" | sha256sum | cut -c1-64
}

image_recipe() {
  podman image inspect --format '{{index .Labels "rea.recipe"}}' "$image" 2>/dev/null || true
}

image_id() {
  podman image inspect --format '{{.Id}}' "$image" 2>/dev/null || true
}

container_image() {
  podman container inspect --format '{{index .Config.Labels "rea.image"}}' "$name" 2>/dev/null || true
}

container_display() {
  podman container inspect --format '{{index .Config.Labels "rea.display"}}' "$name" 2>/dev/null || true
}

# The host's Wayland socket, so tools in the container can open windows on
# the user's screen. Only the socket is shared, on a private tmpfs at the same
# path as on the host; the rest of the runtime folder (D-Bus, PipeWire,
# keyrings) stays out. The identity (path and inode) changes when the session
# restarts, and the container is recreated to follow it. Prints nothing when
# there is no Wayland session.
#
# Off unless REA_CONTAINER_WAYLAND=1: a headed Chromium from the container
# preceded a host hang on a GNOME + DisplayLink (evdi) machine, so tools only
# get the user's screen when they ask for it.
wayland_socket() {
  [ "${REA_CONTAINER_WAYLAND:-0}" = 1 ] || return 0
  local socket="${XDG_RUNTIME_DIR:-}/${WAYLAND_DISPLAY:-}"
  [ -n "${XDG_RUNTIME_DIR:-}" ] && [ -n "${WAYLAND_DISPLAY:-}" ] && [ -S "$socket" ] || return 0
  printf '%s:%s' "$socket" "$(stat -c %i "$socket")"
}

container_state() {
  podman container inspect --format '{{.State.Status}}' "$name" 2>/dev/null || echo missing
}

# Prints current, stale or missing.
image_state() {
  local recipe
  recipe="$(image_recipe)"
  if [ -z "$(image_id)" ]; then
    echo missing
  elif [ "$recipe" = "$(recipe_hash)" ]; then
    echo current
  else
    echo stale
  fi
}

build() {
  local yes="${1:-}"
  [ -f "$repo/dist/application/LinuxHopper.js" ] ||
    fail "build REA first (npm run build:cached); the image build uses its Hopper installer."
  cat <<EOF
Build the REA container image ($image):
  - Fedora 44 with Node.js 24, Xvfb, binwalk, sigrok-cli, gdb, tshark,
    Unblob's extractors, Chromium, adb and uv, and a build toolchain for the
    agent toolbox: npm, Rust (cargo) and gcc-c++ (Fedora's signed repositories)
  - pwndbg 2026.09.15 from its source release (SHA-256 checked) and uv.lock
  - Hopper's official demo, verified by this fork's installer (publisher PGP
    signature, launcher identity); Hopper is separate commercial software
    with its own license, and the demo has vendor-defined limits
About 2 GB of downloads. Nothing on the host system changes; Hopper's
verification evidence is kept in ~/.cache/rea/hopper-releases.
EOF
  if [ "$yes" != "--yes" ]; then
    [ -t 0 ] || fail "not building: no terminal to ask. Rerun with --yes."
    read -r -p "Build it? [y/N] " answer
    [[ "$answer" =~ ^[Yy]([Ee][Ss])?$ ]] || { echo "Not building."; return 1; }
  fi
  mkdir -p "$HOME/.cache/rea"
  # The checkout and the Hopper evidence cache are mounted at their host
  # paths for the build; nothing from them is copied into the image.
  podman build \
    --security-opt label=disable \
    --volume "$repo:$repo:ro" \
    --volume "$HOME/.cache/rea:$HOME/.cache/rea" \
    --build-arg "REA_REPO=$repo" \
    --build-arg "REA_HOME=$HOME" \
    --label "rea.recipe=$(recipe_hash)" \
    --tag "$image" \
    "$here"
}

ensure() {
  [ -n "$(image_id)" ] || fail "no image yet; run frontend/start.sh or $0 build."
  local id state
  id="$(image_id)"
  state="$(container_state)"
  local display
  display="$(wayland_socket)"
  if [ "$state" != missing ] && [ "$(container_image)" != "$id" ]; then
    echo "Recreating the $name container from the rebuilt image."
    podman rm --force "$name" >/dev/null
    state=missing
  elif [ "$state" != missing ] && [ "$(container_display)" != "$display" ]; then
    echo "Recreating the $name container for the current display session."
    podman rm --force "$name" >/dev/null
    state=missing
  fi
  local display_args=()
  if [ -n "$display" ]; then
    local runtime="/run/user/$(id -u)"
    display_args=(
      --tmpfs "$runtime:rw,mode=0700,U"
      --volume "${display%:*}:$runtime/$WAYLAND_DISPLAY"
      --env "XDG_RUNTIME_DIR=$runtime"
      --env "WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
    )
  fi
  case "$state" in
    running) ;;
    missing)
      podman run --detach --init --name "$name" \
        --label "rea.image=$id" \
        --label "rea.display=$display" \
        --network host \
        --userns keep-id \
        --security-opt label=disable \
        --volume "$HOME:$HOME:rslave" \
        --env "HOME=$HOME" \
        --workdir "$HOME" \
        "${display_args[@]}" \
        "$image" sleep infinity >/dev/null
      ;;
    *) podman start "$name" >/dev/null ;;
  esac
}

case "${1:-status}" in
  status)
    printf 'image %s: %s\ncontainer %s: %s\n' "$image" "$(image_state)" "$name" "$(container_state)"
    ;;
  image-state) image_state ;;
  build) build "${2:-}" ;;
  ensure) ensure ;;
  stop) podman stop "$name" >/dev/null 2>&1 || true ;;
  shell) ensure && exec podman exec -it --workdir "$HOME" "$name" bash ;;
  *) fail "unknown command: $1 (status, build, ensure, stop, shell)" ;;
esac
