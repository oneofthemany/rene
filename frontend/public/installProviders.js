// Provider downloads. The bridge fetches pinned releases, checks their
// SHA-256, unpacks them into its providers folder, saves their paths and
// restarts REA; this view picks what to install and shows progress.

import { api, apiJson, ndjson } from "./api.js";
import { h, renderError } from "./render.js";

const mib = (bytes) => `${Math.round(bytes / 1024 / 1024)} MiB`;

const STATE_TEXT = {
  ready: "Installed",
  available: "Installed, not in use",
  configured: "Using your own copy",
  missing: "Not installed",
};

function phaseText(event) {
  switch (event.phase) {
    case "start":
      return "Starting…";
    case "download":
      return `Downloading ${mib(event.received)} of ${mib(event.total)}`;
    case "verify":
      return "Checking SHA-256…";
    case "unpack":
      return "Unpacking…";
    case "build":
      return "Building with uv…";
    case "check":
      return "Checking version…";
    case "installed":
      return "Installed";
    case "present":
      return "Already installed";
    case "cancelled":
      return "Cancelled";
    case "failed":
      return event.error;
    default:
      return event.phase;
  }
}

const CONTAINER_STATE = {
  current: "built",
  stale: "built from an older recipe; start.sh rebuilds it",
  missing: "not built yet; start.sh builds it",
};

/** The container holds the system tools; start.sh builds and runs it. */
async function containerNote() {
  const status = await apiJson("/api/container").catch(() => undefined);
  return h(
    "div",
    { class: "hint install-manual" },
    h("h4", {}, "REA container"),
    h(
      "p",
      {},
      "Hopper (demo), binwalk, sigrok-cli, gdb with pwndbg, Unblob's extractors, Chromium and adb come with the rene podman container (frontend/container), which REA runs in. Run frontend/start.sh to build or update it.",
    ),
    status
      ? h(
          "p",
          {},
          `Image: ${CONTAINER_STATE[status.image] ?? status.image}. Container: ${status.container}.`,
        )
      : null,
  );
}

const idaNote = () =>
  h(
    "p",
    { class: "hint install-manual" },
    "IDA isn't installed from here: it's commercial software from Hex-Rays, and even the free edition needs a Hex-Rays account and license file. Ghidra and Kuna cover the same kind of analysis. If you install IDA later, choose its MCP registration file under Provider paths.",
  );

function installRow(component) {
  const box = h("input", {
    type: "checkbox",
    id: `install-${component.id}`,
    checked: component.recommended,
    disabled: component.state === "ready",
  });
  const progress = h("td", {
    class: "install-progress",
    "aria-live": "polite",
  });
  const element = h(
    "tr",
    {},
    h("td", {}, box),
    h(
      "td",
      {},
      h("label", { for: box.id }, `${component.label} ${component.version}`),
      h("div", { class: "help" }, component.purpose),
    ),
    h("td", {}, STATE_TEXT[component.state]),
    h("td", {}, component.downloadBytes ? mib(component.downloadBytes) : "—"),
    progress,
  );
  return { component, box, progress, element };
}

function installTable(rows) {
  return h(
    "div",
    { class: "setup-table-wrap" },
    h(
      "table",
      { class: "setup-table install-table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          ["", "Provider", "State", "Download", "Progress"].map((title) =>
            h("th", { scope: "col" }, title),
          ),
        ),
      ),
      h(
        "tbody",
        {},
        rows.map((row) => row.element),
      ),
    ),
  );
}

/**
 * Starts an install and follows its progress. Resolves to the final "done"
 * or "error" event.
 */
async function streamInstall(
  ids,
  { onProgress, onRestarting, path = "/api/install" },
) {
  let outcome;
  try {
    const response = await api(path, {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    if (!response.ok)
      throw new Error(
        (await response.json()).error ?? `HTTP ${response.status}`,
      );
    for await (const event of ndjson(response.body)) {
      if (event.type === "progress") onProgress(event);
      else if (event.type === "restarting") onRestarting();
      else if (event.type === "done" || event.type === "error") outcome = event;
    }
  } catch (cause) {
    outcome = { type: "error", error: cause.message };
  }
  return outcome ?? { type: "error", error: "The install stopped early." };
}

const outcomeText = (outcome) =>
  outcome.type === "error"
    ? outcome.error
    : outcome.cancelled
      ? "Install cancelled. Finished providers were kept and saved."
      : "Some providers failed; the others were installed and saved.";

/** Shows that an install started elsewhere is running, until it ends. */
function waitForRunning(area, heading, onInstalled) {
  area.replaceChildren(
    heading,
    h(
      "p",
      { class: "hint" },
      "An install is running. This view updates when it finishes.",
    ),
  );
  const timer = setInterval(async () => {
    if (!area.isConnected) return clearInterval(timer);
    const next = await apiJson("/api/install").catch(() => undefined);
    if (next && !next.running) {
      clearInterval(timer);
      await onInstalled();
    }
  }, 2000);
  return area;
}

/** Restarting REA cancels running calls; returns how many there are. */
async function runningCalls() {
  const status = await apiJson("/api/status");
  return status.activeCalls?.length ?? 0;
}

function installForm(plan, onInstalled) {
  // Things the user turned off under "What you use" aren't offered.
  const rows = plan.components.filter((c) => c.used).map(installRow);
  const byId = new Map(rows.map((row) => [row.component.id, row]));
  const install = h("button", { type: "button", class: "primary" });
  const cancel = h(
    "button",
    {
      type: "button",
      class: "quiet",
      hidden: true,
      onclick: () =>
        void apiJson("/api/install/cancel", { method: "POST" }).catch(() => {}),
    },
    "Cancel",
  );
  const formError = h("span", { class: "form-error", role: "alert" });
  let confirmRunning = false;

  const chosen = () => rows.filter((row) => row.box.checked);
  function refreshButton() {
    const bytes = chosen().reduce(
      (sum, row) => sum + row.component.downloadBytes,
      0,
    );
    install.disabled = chosen().length === 0;
    install.textContent = rows.every((row) => row.component.state === "ready")
      ? "All installed"
      : bytes
        ? `Download and install (${mib(bytes)})`
        : "Install";
  }
  for (const row of rows)
    row.box.addEventListener("change", () => {
      // Ghidra and JADX need Java; pick it too when REA has none.
      const needs = byId.get(row.component.needs);
      if (row.box.checked && needs && !needs.component.current.JAVA_HOME)
        needs.box.checked = true;
      confirmRunning = false;
      refreshButton();
    });
  refreshButton();

  async function run() {
    const running = await runningCalls();
    if (running && !confirmRunning) {
      confirmRunning = true;
      install.textContent = "Install and cancel running calls";
      formError.textContent = `${running} ${running === 1 ? "call is" : "calls are"} running. REA restarts after installing, which cancels ${running === 1 ? "it" : "them"}. Click again to install.`;
      return;
    }
    formError.textContent = "";
    install.disabled = true;
    install.textContent = "Installing…";
    cancel.hidden = false;
    for (const row of rows) row.box.disabled = true;
    const outcome = await streamInstall(
      chosen().map((row) => row.component.id),
      {
        onProgress(event) {
          const cell = byId.get(event.id).progress;
          cell.textContent = phaseText(event);
          cell.dataset.phase = event.phase;
        },
        onRestarting: () => (install.textContent = "Restarting REA…"),
      },
    );
    cancel.hidden = true;
    if (outcome.type === "done" && !outcome.failed.length && !outcome.cancelled)
      return onInstalled();
    formError.textContent = outcomeText(outcome);
    install.textContent = "Check again";
    install.disabled = false;
    install.onclick = () => void onInstalled();
  }
  install.onclick = () => void run();

  return [
    installTable(rows),
    h("div", { class: "actions" }, install, cancel, formError),
    updateControls(byId, onInstalled),
  ];
}

/**
 * "Check for updates": lists newer releases REA accepts for providers this
 * workbench installed, and installs the ones shown after a click.
 */
function updateControls(byId, onInstalled) {
  const list = h("ul", { class: "update-list" });
  const status = h("span", { class: "help", role: "status" });
  const check = h(
    "button",
    { type: "button", class: "quiet" },
    "Check for updates",
  );
  const area = h(
    "div",
    { class: "provider-updates" },
    h("div", { class: "actions" }, check, status),
    list,
  );

  async function apply(updates, button) {
    button.disabled = true;
    button.textContent = "Updating…";
    const outcome = await streamInstall(
      updates.map((update) => update.id),
      {
        path: "/api/install/update",
        onProgress(event) {
          const cell = byId.get(event.id)?.progress;
          if (!cell) return;
          cell.textContent = phaseText(event);
          cell.dataset.phase = event.phase;
        },
        onRestarting: () => (button.textContent = "Restarting REA…"),
      },
    );
    if (outcome.type === "done" && !outcome.failed.length && !outcome.cancelled)
      return onInstalled();
    status.textContent = outcomeText(outcome);
    button.remove();
  }

  check.onclick = async () => {
    check.disabled = true;
    status.textContent = "Checking…";
    list.replaceChildren();
    let found;
    try {
      found = await apiJson("/api/install/updates");
    } catch (cause) {
      status.textContent = cause.message;
      check.disabled = false;
      return;
    }
    check.disabled = false;
    const notes = found.unchecked.map(
      ({ label, reason }) => `Couldn't check ${label}: ${reason}`,
    );
    if (found.updates.length === 0) {
      status.textContent = ["Everything is up to date.", ...notes].join(" ");
      return;
    }
    status.textContent = notes.join(" ");
    const bytes = found.updates.reduce(
      (sum, update) => sum + update.release.size,
      0,
    );
    const update = h(
      "button",
      { type: "button", class: "primary" },
      `Update (${mib(bytes)})`,
    );
    update.onclick = () => void apply(found.updates, update);
    list.replaceChildren(
      ...found.updates.map((item) =>
        h(
          "li",
          {},
          `${item.label}: ${item.from} → ${item.to}, ${mib(item.release.size)}`,
        ),
      ),
      h("li", { class: "update-action" }, update),
    );
  };
  return area;
}

/**
 * Renders the install section. onInstalled runs after REA has restarted with
 * the new paths (or after an install started elsewhere finishes).
 */
export async function renderInstallProviders({ onInstalled }) {
  const area = h("section", { class: "provider-install" });
  let plan;
  try {
    plan = await apiJson("/api/install");
  } catch (cause) {
    area.replaceChildren(renderError(undefined, cause.message));
    return area;
  }
  const heading = h("h3", {}, "Install providers");
  if (plan.running) return waitForRunning(area, heading, onInstalled);
  area.replaceChildren(
    heading,
    plan.supported
      ? h(
          "p",
          { class: "hint" },
          `Downloads pinned upstream releases, checks each SHA-256 and unpacks them into ${plan.root}. Nothing else on the system changes and no administrator access is used. Their paths are then saved for REA.`,
        )
      : h(
          "p",
          { class: "hint" },
          `Provider downloads support Linux x64 and arm64, not ${plan.host}. Set provider paths below instead.`,
        ),
    ...(plan.supported ? installForm(plan, onInstalled) : []),
    await containerNote(),
    idaNote(),
  );
  return area;
}
