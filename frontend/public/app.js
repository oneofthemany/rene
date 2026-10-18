import {
  api,
  apiJson,
  getToken,
  ndjson,
  onTokenRejected,
  readToken,
  setToken,
} from "./api.js";
import { effectBadge, GROUPS, groupTools } from "./catalog.js";
import { createForm } from "./form.js";
import { h, renderError } from "./render.js";
import {
  renderHistory as drawHistory,
  showEntry as drawEntry,
} from "./results.js";

const state = {
  tools: [],
  selected: undefined,
  /** Active view of the current tool: { tool, form, mode, raw } */
  view: undefined,
  running: undefined,
  history: [],
};

// ---------------------------------------------------------------------------
// Token

function showTokenGate() {
  document.getElementById("token-gate").hidden = false;
  document.getElementById("token-input").focus();
}

document.getElementById("token-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const raw = document.getElementById("token-input").value.trim();
  const token = raw.includes("token=")
    ? new URLSearchParams(raw.split("#")[1] ?? "").get("token")
    : raw;
  if (!token) return;
  setToken(token);
  document.getElementById("token-gate").hidden = true;
  void boot();
});

// ---------------------------------------------------------------------------
// Server status

async function refreshStatus() {
  const dot = document.querySelector("#server-status .dot");
  const text = document.querySelector("#server-status .server-text");
  try {
    const status = await apiJson("/api/status");
    dot.dataset.state = status.state;
    text.textContent =
      status.state === "ready"
        ? `${status.serverVersion?.name ?? "rea"} ${status.serverVersion?.version ?? ""}, ${status.toolCount} tools`
        : status.state === "failed"
          ? `Server stopped: ${status.failure ?? "unknown failure"}`
          : "Starting REA…";
    document.getElementById("server-log").textContent =
      status.stderrTail || "No server output yet.";
    return status;
  } catch (cause) {
    dot.dataset.state = "failed";
    text.textContent = cause.message;
    return undefined;
  }
}

document
  .getElementById("toggle-log")
  .addEventListener("click", async (event) => {
    const log = document.getElementById("server-log");
    log.hidden = !log.hidden;
    event.currentTarget.setAttribute("aria-expanded", String(!log.hidden));
    if (!log.hidden) await refreshStatus();
  });

document.getElementById("restart").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Restarting…";
  try {
    await apiJson("/api/restart", { method: "POST" });
    await loadTools();
  } finally {
    button.disabled = false;
    button.textContent = "Restart server";
    await refreshStatus();
  }
});

// ---------------------------------------------------------------------------
// Catalog

async function loadTools() {
  const { tools } = await apiJson("/api/tools");
  state.tools = tools;
  document.getElementById("tool-filter").placeholder =
    `Filter ${tools.length} tools`;
  renderCatalog();
}

function renderCatalog() {
  const filter = document
    .getElementById("tool-filter")
    .value.trim()
    .toLowerCase();
  const groups = groupTools(state.tools, filter);
  const container = document.getElementById("tool-groups");
  container.replaceChildren(
    ...groups.map(([label, tools]) =>
      h(
        "details",
        {
          open:
            Boolean(filter) ||
            tools.some((tool) => tool.name === state.selected) ||
            label === GROUPS[0][0],
        },
        h("summary", {}, label, h("span", { class: "count" }, tools.length)),
        h(
          "ul",
          {},
          tools.map((tool) =>
            h(
              "li",
              {},
              h(
                "button",
                {
                  type: "button",
                  class: "tool-item",
                  "aria-current": String(tool.name === state.selected),
                  title: tool.title ?? tool.name,
                  onclick: () => selectTool(tool.name),
                },
                h("span", { class: "name" }, tool.name),
                effectBadge(tool.annotations),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  if (groups.length === 0)
    container.replaceChildren(
      h("p", { class: "hint catalog-empty" }, `No tools match “${filter}”.`),
    );
}

document.getElementById("tool-filter").addEventListener("input", renderCatalog);

// ---------------------------------------------------------------------------
// Tool view

/** Optional picker that fills the form from the schema's examples. */
function exampleSelect(examples) {
  if (examples.length === 0) return null;
  return h(
    "select",
    {
      "aria-label": "Fill from an example",
      onchange: (event) => {
        const example = examples[Number(event.target.value)];
        if (example) writeArgs(example);
        event.target.value = "";
      },
    },
    h("option", { value: "" }, "Fill from example"),
    examples.map((_, index) =>
      h("option", { value: String(index) }, `Example ${index + 1}`),
    ),
  );
}

/** Tool description, clamped to three lines when long. */
function descriptionBlock(text) {
  const description = h(
    "p",
    { class: "description", "data-collapsed": "true" },
    text,
  );
  const expand =
    text.length > 320
      ? h(
          "button",
          {
            type: "button",
            class: "link",
            onclick: (event) => {
              const collapsed = description.dataset.collapsed === "true";
              description.dataset.collapsed = String(!collapsed);
              event.currentTarget.textContent = collapsed
                ? "Show less"
                : "Show full description";
            },
          },
          "Show full description",
        )
      : null;
  if (!expand) description.dataset.collapsed = "false";
  return [description, expand];
}

async function selectTool(name, presetArgs) {
  state.selected = name;
  renderCatalog();
  const view = document.getElementById("tool-view");
  view.replaceChildren(h("p", { class: "hint" }, `Loading ${name}…`));
  let tool;
  try {
    tool = await apiJson(`/api/tools/${encodeURIComponent(name)}`);
  } catch (cause) {
    view.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  if (state.selected !== name) return;

  const form = createForm(tool.inputSchema);
  const raw = h("textarea", {
    class: "raw-json",
    spellcheck: "false",
    "aria-label": "Arguments as JSON",
  });
  const formError = h("span", { class: "form-error", role: "alert" });
  const runButton = h("button", { type: "submit", class: "primary" }, "Run");
  const cancelButton = h(
    "button",
    { type: "button", class: "quiet", hidden: true, onclick: cancelRun },
    "Cancel",
  );
  state.view = {
    tool,
    form,
    raw,
    mode: "form",
    runButton,
    cancelButton,
    formError,
    confirming: false,
  };

  const initial = presetArgs ?? loadLastArgs(name) ?? {};
  form.write(initial);
  raw.value = JSON.stringify(initial, null, 2);

  const formMode = h(
    "button",
    { type: "button", "aria-pressed": "true", onclick: () => setMode("form") },
    "Form",
  );
  const jsonMode = h(
    "button",
    { type: "button", "aria-pressed": "false", onclick: () => setMode("json") },
    "JSON",
  );
  const examples = exampleSelect(tool.inputSchema?.examples ?? []);
  const formHost = h("div", {}, form.element);
  const rawHost = h("div", { hidden: true }, raw);

  const [description, expand] = descriptionBlock(tool.description ?? "");

  view.replaceChildren(
    h(
      "div",
      { class: "tool-head" },
      h("h2", {}, tool.title ?? tool.name),
      h("div", { class: "tool-name" }, tool.name),
      h("div", { class: "effects" }, effectBadge(tool.annotations)),
    ),
    description,
    expand,
    h(
      "form",
      { onsubmit: (event) => (event.preventDefault(), void run()) },
      h(
        "div",
        { class: "mode-switch" },
        formMode,
        jsonMode,
        h("span", { class: "spacer" }),
        examples,
      ),
      formHost,
      rawHost,
      h("div", { class: "actions" }, runButton, cancelButton, formError),
    ),
  );

  function setMode(mode) {
    if (mode === state.view.mode) return;
    if (mode === "json") {
      const read = form.read();
      if (!read.ok) return;
      raw.value = JSON.stringify(read.args, null, 2);
    } else {
      const parsed = parseRaw();
      if (!parsed) return;
      form.write(parsed);
    }
    state.view.mode = mode;
    formHost.hidden = mode !== "form";
    rawHost.hidden = mode !== "json";
    formMode.setAttribute("aria-pressed", String(mode === "form"));
    jsonMode.setAttribute("aria-pressed", String(mode === "json"));
  }
}

function writeArgs(args) {
  state.view.form.write(args);
  state.view.raw.value = JSON.stringify(args, null, 2);
}

function parseRaw() {
  const { raw, formError } = state.view;
  formError.textContent = "";
  try {
    const parsed = JSON.parse(raw.value.trim() || "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Arguments must be a JSON object.");
    return parsed;
  } catch (cause) {
    formError.textContent = cause.message;
    return undefined;
  }
}

function currentArgs() {
  const { form, mode, formError } = state.view;
  formError.textContent = "";
  if (mode === "json") return parseRaw();
  const read = form.read();
  if (!read.ok) {
    formError.textContent = "Fix the highlighted arguments.";
    return undefined;
  }
  return read.args;
}

function loadLastArgs(name) {
  try {
    const stored = localStorage.getItem(`rea-args:${name}`);
    return stored ? JSON.parse(stored) : undefined;
  } catch {
    return undefined;
  }
}

function saveLastArgs(name, args) {
  try {
    localStorage.setItem(`rea-args:${name}`, JSON.stringify(args));
  } catch {
    // Remembered arguments are a convenience only.
  }
}

// ---------------------------------------------------------------------------
// Running tools

async function run() {
  if (state.running) return;
  const view = state.view;
  const args = currentArgs();
  if (!args) return;
  // Tools that may change external state need a second, deliberate click.
  if (view.tool.annotations?.destructiveHint && !view.confirming) {
    view.confirming = true;
    view.runButton.textContent = "Confirm run";
    view.formError.textContent =
      "This tool may change or remove external state. Click again to run it.";
    return;
  }
  view.confirming = false;
  view.runButton.textContent = "Run";
  saveLastArgs(view.tool.name, args);

  const entry = {
    name: view.tool.name,
    args,
    startedAt: Date.now(),
    outcome: "running",
  };
  state.history.unshift(entry);
  state.running = { entry, callId: undefined };
  renderHistory();
  view.runButton.disabled = true;
  view.cancelButton.hidden = false;

  const resultView = document.getElementById("result-view");
  const progress = h("progress", { "aria-label": "Progress" });
  const progressText = h("span", {}, "Running…");
  resultView.replaceChildren(
    h(
      "div",
      { class: "run-line" },
      h("strong", {}, entry.name),
      progress,
      progressText,
    ),
  );

  try {
    const response = await api("/api/call", {
      method: "POST",
      body: JSON.stringify({ name: entry.name, arguments: args }),
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Request failed with ${response.status}.`);
    }
    for await (const event of ndjson(response.body)) {
      if (event.type === "started") state.running.callId = event.id;
      else if (event.type === "progress") {
        if (typeof event.total === "number") {
          progress.max = event.total;
          progress.value = event.progress;
        }
        progressText.textContent =
          event.message ??
          `Progress ${event.progress}${event.total ? ` of ${event.total}` : ""}`;
      } else if (event.type === "result") {
        entry.result = event.result;
        entry.elapsedMs = event.elapsedMs;
        entry.outcome = event.result.isError ? "error" : "ok";
      } else if (event.type === "error") {
        entry.failure = event.message;
        entry.cancelled = event.cancelled;
        entry.elapsedMs = event.elapsedMs;
        entry.outcome = "error";
      }
    }
    if (entry.outcome === "running") {
      entry.outcome = "error";
      entry.failure = "The bridge closed the call without a result.";
    }
  } catch (cause) {
    entry.outcome = "error";
    entry.failure = cause.message;
  } finally {
    state.running = undefined;
    if (state.view === view) {
      view.runButton.disabled = false;
      view.cancelButton.hidden = true;
    }
    renderHistory();
    showEntry(entry);
  }
}

async function cancelRun() {
  const callId = state.running?.callId;
  if (callId === undefined) return;
  state.view.cancelButton.textContent = "Cancelling…";
  await apiJson(`/api/calls/${callId}/cancel`, { method: "POST" }).catch(
    () => {},
  );
  state.view.cancelButton.textContent = "Cancel";
}

// ---------------------------------------------------------------------------
// Results

function openEvidence(evidenceId) {
  void selectTool("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: evidenceId },
    view: { kind: "summary" },
  });
  document.getElementById("result-view").replaceChildren();
}

const showEntry = (entry) => drawEntry(entry, openEvidence);

const renderHistory = () =>
  drawHistory(state.history, async (entry) => {
    await selectTool(entry.name, entry.args);
    showEntry(entry);
  });

// ---------------------------------------------------------------------------
// Boot

document.addEventListener("click", (event) => {
  const target = event.target.closest?.("[data-open-tool]");
  if (target) void selectTool(target.dataset.openTool);
});

async function boot() {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await refreshStatus();
    if (!status) return;
    if (status.state === "ready") break;
    if (status.state === "failed") return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  await loadTools();
}

onTokenRejected(showTokenGate);
if (readToken()) void boot();
else showTokenGate();
setInterval(() => {
  if (getToken() && !document.hidden) void refreshStatus();
}, 15_000);
