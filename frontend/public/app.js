import {
  apiJson,
  getToken,
  onTokenRejected,
  readToken,
  setToken,
} from "./api.js";
import { cancelCall, isLive, startCall } from "./calls.js";
import { effectBadge, renderCatalog as drawCatalog } from "./catalog.js";
import { createForm, matchingArgs } from "./form.js";
import { h, renderError } from "./render.js";
import {
  renderHistory as drawHistory,
  showEntry as drawEntry,
  showLive,
} from "./results.js";
import { showSetup } from "./setup.js";
import { renderWorkflowPanel, showWorkflowForm } from "./workflows.js";

const state = {
  tools: [],
  prompts: [],
  /** { kind: "tool" | "prompt", name } */
  selected: undefined,
  /** Active guided workflow: { prompt, args, result, startedAt } */
  workflow: undefined,
  /** Active view of the current tool: { tool, form, mode, raw } */
  view: undefined,
  /** The call whose live status or result is shown below the form. */
  shown: undefined,
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
        ? `${status.serverVersion?.name ?? "rea"} ${status.serverVersion?.version ?? ""}, ${status.toolCount} tools, ${status.promptCount} workflows`
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

document.getElementById("open-setup").addEventListener("click", () => {
  state.selected = { kind: "setup" };
  state.view = undefined;
  renderCatalog();
  void showSetup(document.getElementById("tool-view"));
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
  const [{ tools }, { prompts }] = await Promise.all([
    apiJson("/api/tools"),
    apiJson("/api/prompts"),
  ]);
  state.tools = tools;
  state.prompts = prompts;
  document.getElementById("tool-filter").placeholder =
    "Filter tools and workflows";
  renderCatalog();
  renderWorkflow();
}

function renderCatalog() {
  drawCatalog({
    tools: state.tools,
    prompts: state.prompts,
    filter: document.getElementById("tool-filter").value.trim().toLowerCase(),
    selected: state.selected,
    onTool: (name) => void selectTool(name),
    onPrompt: (name) => void selectPrompt(name),
  });
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

/** Starting arguments: an explicit preset, else last-used values plus workflow matches. */
function initialArgs(tool, presetArgs, prefill) {
  if (presetArgs) return { initial: presetArgs, prefillNote: null };
  const prefilled = prefill ? matchingArgs(tool.inputSchema, prefill) : {};
  const names = Object.keys(prefilled);
  return {
    initial: { ...loadLastArgs(tool.name), ...prefilled },
    prefillNote: names.length
      ? h(
          "p",
          { class: "hint" },
          `Filled from the workflow: ${names.join(", ")}.`,
        )
      : null,
  };
}

/**
 * Opens a tool. presetArgs replaces the form; prefill (workflow arguments)
 * fills only properties with exactly the same name.
 */
async function selectTool(name, presetArgs, prefill) {
  state.selected = { kind: "tool", name };
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
  if (state.selected?.kind !== "tool" || state.selected.name !== name) return;

  const form = createForm(tool.inputSchema);
  const raw = h("textarea", {
    class: "raw-json",
    spellcheck: "false",
    "aria-label": "Arguments as JSON",
  });
  const formError = h("span", { class: "form-error", role: "alert" });
  const runButton = h("button", { type: "submit", class: "primary" }, "Run");
  state.view = {
    tool,
    form,
    raw,
    mode: "form",
    runButton,
    formError,
    confirming: false,
  };

  const { initial, prefillNote } = initialArgs(tool, presetArgs, prefill);
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

  // Optional parts are null; DOM replaceChildren would print them as "null".
  const parts = [
    h(
      "div",
      { class: "tool-head" },
      h("h2", {}, tool.title ?? tool.name),
      h("div", { class: "tool-name" }, tool.name),
      h("div", { class: "effects" }, effectBadge(tool.annotations)),
    ),
    description,
    expand,
    prefillNote,
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
      h("div", { class: "actions" }, runButton, formError),
    ),
  ];
  view.replaceChildren(...parts.filter(Boolean));

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

/** Starts a call for the current tool. Calls run concurrently. */
function run() {
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

  const entry = startCall(view.tool.name, args, scheduleRender);
  state.history.unshift(entry);
  state.shown = entry;
  scheduleRender();
}

let renderPending = false;
/** Coalesces call updates into one render per frame. */
function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    renderHistory();
    renderWorkflow();
    renderShown();
  });
}

let renderedFinal;
/** Shows the selected call; a settled result renders once so tabs and scroll persist. */
function renderShown(force = false) {
  const entry = state.shown;
  if (!entry) return;
  if (isLive(entry)) {
    renderedFinal = undefined;
    showLive(entry, cancelCall);
  } else if (force || renderedFinal !== entry) {
    renderedFinal = entry;
    drawEntry(entry, openEvidence);
  }
}

// ---------------------------------------------------------------------------
// Guided workflows

function selectPrompt(name) {
  const prompt = state.prompts.find((candidate) => candidate.name === name);
  if (!prompt) return;
  state.selected = { kind: "prompt", name };
  renderCatalog();
  showWorkflowForm(prompt, {
    onStart: (workflow) => {
      state.workflow = workflow;
      renderWorkflow();
      document
        .getElementById("workflow-panel")
        .scrollIntoView({ block: "start" });
    },
  });
}

function renderWorkflow() {
  const workflow = state.workflow;
  // Latest outcome per tool since the workflow started; history is newest first.
  const outcomes = new Map();
  for (const entry of state.history) {
    if (!workflow || entry.startedAt < workflow.startedAt) break;
    if (!isLive(entry) && !outcomes.has(entry.name)) {
      outcomes.set(entry.name, entry.outcome);
    }
  }
  renderWorkflowPanel(workflow, {
    toolNames: new Set(state.tools.map((tool) => tool.name)),
    outcomes,
    onTool: (name) => void selectTool(name, undefined, workflow?.args),
    onClose: () => {
      state.workflow = undefined;
      renderWorkflow();
    },
  });
}

// ---------------------------------------------------------------------------
// Results

function openEvidence(evidenceId) {
  state.shown = undefined;
  void selectTool("inspect_analysis_view", {
    source: { kind: "retained-evidence", evidence_id: evidenceId },
    view: { kind: "summary" },
  });
  document.getElementById("result-view").replaceChildren();
}

const renderHistory = () =>
  drawHistory(state.history, {
    shown: state.shown,
    onCancel: cancelCall,
    onSelect: async (entry) => {
      state.shown = entry;
      await selectTool(entry.name, entry.args);
      renderShown(true);
      renderHistory();
    },
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
