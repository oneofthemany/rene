import {
  api,
  apiJson,
  getToken,
  ndjson,
  onTokenRejected,
  readToken,
  setToken,
} from "./api.js";
import {
  cancelCall,
  clearStoredHistory,
  fromBridge,
  isLive,
  loadAudit,
  loadStoredHistory,
  loadStoredResult,
  loadTurn,
  loadTopics,
  loadToolUsage,
  loadTurns,
  countToolUse,
  startCall,
} from "./calls.js";
import { renderTopics, setTopicsExpanded } from "./topics.js";
import { effectBadge, renderCatalog as drawCatalog } from "./catalog.js";
import { initAgent } from "./agent.js";
import { assessmentDocument, initProjects } from "./projects.js";
import { refreshDoctor, showProviders } from "./doctor.js";
import { createForm, matchingArgs } from "./form.js";
import { h, renderError } from "./render.js";
import {
  renderHistory as drawHistory,
  showEntry as drawEntry,
  showAudit,
  showLive,
  setTurnsExpanded,
  showTurn,
  updateLinks,
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
  /** Calls of the active project (or the unassigned ones), newest first. */
  history: [],
  /** Calls per tool in that history (loadToolUsage); undefined until read. */
  usage: undefined,
  /** History filter: "all", "agent" or "workbench". */
  source: "all",
};

/** Active project, set once projects load. */
let projects;
/** Agent controls and terminal, set once the agent panel is built. */
let agent;
const activeProject = () => projects?.current();

// ---------------------------------------------------------------------------
// Where the page is, kept in this tab's session storage. A browser can reload
// a tab at any time (a discarded background tab, a renderer crash, a reload
// key); the page then returns to the same tool, result, brief and tabs.

const VIEW_KEY = "rea-view";
// Nothing is saved until the view from before the reload is restored, so the
// page's own start-up rendering can't overwrite it.
let restoringView = true;

function saveView() {
  if (restoringView) return;
  const workflow = state.workflow;
  try {
    sessionStorage.setItem(
      VIEW_KEY,
      JSON.stringify({
        selected: state.selected,
        shown: state.shown?.historyId,
        side:
          document
            .getElementById("tab-project")
            .getAttribute("aria-selected") === "true"
            ? "project"
            : "history",
        source: state.source,
        workflow: workflow && {
          prompt: workflow.prompt.name,
          args: workflow.args,
          result: workflow.result,
          startedAt: workflow.startedAt,
        },
      }),
    );
  } catch {
    // Storage full or blocked: the page works, it just won't come back here.
  }
}

function savedView() {
  try {
    return JSON.parse(sessionStorage.getItem(VIEW_KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

/** The active project's history load in progress, if any. */
let historyLoading;
/** Where the next, older page of history starts; undefined when none remain. */
let olderHistory;
let catalogLoaded;
const catalogReady = new Promise((resolve) => (catalogLoaded = resolve));

const viewAtLoad = savedView();

/** Puts the page back where it was before a reload, once its data is in. */
async function restoreView() {
  const view = viewAtLoad;
  try {
    if (!view) return;
    await Promise.all([catalogReady, historyLoading]);
    if (view.source) setSource(view.source);
    if (view.side) showSideTab(view.side);
    const prompt = state.prompts.find(
      (candidate) => candidate.name === view.workflow?.prompt,
    );
    if (prompt) {
      state.workflow = { ...view.workflow, prompt };
      renderWorkflow();
    }
    const selected = view.selected;
    const shown = state.history.find((entry) => entry.historyId === view.shown);
    if (selected?.kind === "tool" && shown?.name === selected.name)
      await showCall(shown);
    else if (selected?.kind === "tool") await selectTool(selected.name);
    else if (selected?.kind === "prompt") selectPrompt(selected.name);
    else if (selected?.kind)
      document.getElementById(`open-${selected.kind}`)?.click();
  } finally {
    restoringView = false;
    saveView();
  }
}

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

/** The active project's assessment, full width in place of the tool view. */
function showAssessmentView(project, assessment) {
  state.selected = { kind: "assessment" };
  state.view = undefined;
  state.shown = undefined;
  renderCatalog();
  document.getElementById("result-view").replaceChildren();
  let raw = false;
  const body = h("div");
  const toggle = h("button", { type: "button", class: "quiet" }, "Markdown");
  const draw = () => {
    body.replaceChildren(assessmentDocument(assessment.text, raw));
    toggle.textContent = raw ? "Formatted" : "Markdown";
  };
  toggle.onclick = () => {
    raw = !raw;
    draw();
  };
  draw();
  document
    .getElementById("tool-view")
    .replaceChildren(
      h(
        "section",
        { class: "assessment-page" },
        h(
          "div",
          { class: "tool-head" },
          h("h2", {}, `Assessment — ${project.name}`),
          h("div", { class: "tool-name" }, assessment.file),
          h("div", { class: "effects" }, toggle),
        ),
        body,
      ),
    );
}

/** Shows the agent terminal in place of the tool and result panes. */
function showAgentView() {
  state.selected = { kind: "agent" };
  state.view = undefined;
  renderCatalog();
  document.getElementById("result-view").replaceChildren();
  agent?.show(document.getElementById("tool-view"));
}

document.getElementById("open-agent").addEventListener("click", showAgentView);

// Header views that replace both the tool and result panes.
for (const [kind, show] of [
  ["providers", showProviders],
  ["setup", showSetup],
]) {
  document.getElementById(`open-${kind}`).addEventListener("click", () => {
    state.selected = { kind };
    state.view = undefined;
    renderCatalog();
    document.getElementById("result-view").replaceChildren();
    void show(document.getElementById("tool-view"));
  });
}

document.getElementById("restart").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Restarting…";
  try {
    // The catalog event for the new server reloads the catalog.
    await apiJson("/api/restart", { method: "POST" });
  } finally {
    button.disabled = false;
    button.textContent = "Restart server";
    await refreshStatus();
  }
});

// ---------------------------------------------------------------------------
// Catalog

let loadedCatalog;
/**
 * Follows the bridge's catalog events. A restart or REA's list_changed
 * notification changes the stamp, and the page reloads its catalog.
 */
async function followCatalog() {
  for (;;) {
    try {
      const response = await api("/api/events");
      for await (const event of ndjson(response.body)) {
        if (event.type === "history") {
          mergeBridgeEntry(event);
          reloadTopics();
          continue;
        }
        if (event.type === "assessment") {
          projects?.assessmentChanged(event.project);
          continue;
        }
        if (event.type === "conversation") {
          conversationChanged(event);
          continue;
        }
        const stamp = `${event.startedAt}:${event.catalogVersion}`;
        if (event.type !== "catalog" || stamp === loadedCatalog) continue;
        loadedCatalog = stamp;
        await loadTools();
        void refreshStatus();
      }
    } catch {
      // The bridge restarted or the network dropped; reconnect below.
    }
    if (!getToken()) return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

async function loadTools() {
  const [{ tools }, { prompts }] = await Promise.all([
    apiJson("/api/tools"),
    apiJson("/api/prompts"),
  ]);
  state.tools = tools;
  state.prompts = prompts;
  catalogLoaded();
  document.getElementById("tool-filter").placeholder =
    "Filter tools and workflows";
  renderCatalog();
  renderWorkflow();
}

function renderCatalog() {
  drawCatalog({
    tools: state.tools,
    prompts: state.prompts,
    usage: state.usage,
    filter: document.getElementById("tool-filter").value.trim().toLowerCase(),
    selected: state.selected,
    onTool: (name) => void selectTool(name),
    onPrompt: (name) => void selectPrompt(name),
  });
  // Every selection change redraws the catalog, so it also records it.
  saveView();
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

  const entry = startCall(
    view.tool.name,
    args,
    activeProject()?.id,
    scheduleRender,
  );
  state.history.unshift(entry);
  state.shown = entry;
  scheduleRender();
}

let renderPending = false;
/** Coalesces call updates into one render per frame. */
/** Set when tool usage changed; the next scheduled render redraws the catalog. */
let catalogStale = false;

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    if (catalogStale) {
      catalogStale = false;
      renderCatalog();
    }
    renderHistory();
    renderWorkflow();
    renderShown();
    saveView();
  });
}

let renderedFinal;
/** Shows the selected call; a settled result renders once so tabs and scroll persist. */
function renderShown(force = false) {
  const entry = state.shown;
  // A conversation turn draws itself once, in showCall.
  if (!entry || entry.kind === "turn") return;
  if (isLive(entry)) {
    renderedFinal = undefined;
    showLive(entry, cancelCall);
  } else if (force || renderedFinal !== entry) {
    renderedFinal = entry;
    drawEntry(entry, openEvidence, openEarlier);
    // The conversation around an agent's call, when one was recorded.
    if (entry.source === "agent" && entry.project)
      void loadAudit(entry)
        .then((audit) => state.shown === entry && showAudit(entry, audit))
        .catch(() => {});
  }
}

/** Shows the call whose result supplied a value, if it is still in history. */
function openEarlier(historyId) {
  const entry = state.history.find(
    (candidate) => candidate.historyId === historyId,
  );
  if (entry) void showCall(entry);
}

async function showCall(entry) {
  state.shown = entry;
  if (entry.kind === "turn") {
    state.selected = undefined;
    renderCatalog();
    document.getElementById("tool-view").replaceChildren();
    try {
      showTurn(await loadTurn(entry), openEarlier);
    } catch (cause) {
      document
        .getElementById("result-view")
        .replaceChildren(renderError(undefined, cause.message));
    }
    renderHistory();
    return;
  }
  await Promise.all([
    selectTool(entry.name, entry.args),
    loadStoredResult(entry),
  ]);
  renderShown(true);
  renderHistory();
}

let turnsReload;
/** New transcript lines: refresh the active project's turns in History. */
function conversationChanged({ project }) {
  if (project !== activeProject()?.id) return;
  clearTimeout(turnsReload);
  turnsReload = setTimeout(async () => {
    const turns = await loadTurns(project);
    if (project !== activeProject()?.id) return;
    const shownId = state.shown?.historyId;
    state.history = [
      ...state.history.filter((entry) => entry.kind !== "turn"),
      ...turns,
    ].sort((a, b) => b.startedAt - a.startedAt);
    // A turn being read keeps its place; the newer copy replaces it.
    if (state.shown?.kind === "turn")
      state.shown =
        state.history.find((entry) => entry.historyId === shownId) ??
        state.shown;
    scheduleRender();
    reloadTopics();
  }, 1500);
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
      saveView();
      document
        .getElementById("workflow-panel")
        .scrollIntoView({ block: "start" });
    },
  });
}

let drawnWorkflow;
/**
 * Draws the pinned brief when the workflow, the catalog or a tool's outcome
 * changes. Call progress and other history updates leave it alone, so its
 * scroll position and open state hold while calls run.
 */
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
  const drawn = {
    workflow,
    tools: state.tools,
    outcomes: [...outcomes].join(),
  };
  if (
    drawnWorkflow !== undefined &&
    drawnWorkflow.workflow === drawn.workflow &&
    drawnWorkflow.tools === drawn.tools &&
    drawnWorkflow.outcomes === drawn.outcomes
  )
    return;
  drawnWorkflow = drawn;
  renderWorkflowPanel(workflow, {
    toolNames: new Set(state.tools.map((tool) => tool.name)),
    outcomes,
    onTool: (name) => void selectTool(name, undefined, workflow?.args),
    onClose: () => {
      state.workflow = undefined;
      renderWorkflow();
      saveView();
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

let topicsTree;
let topicsDrawn;
let topicsLoading;
/** Reloads the topic tree when the Topics view is showing. */
function reloadTopics() {
  const project = activeProject()?.id;
  if (state.source !== "topics" || !project) return;
  clearTimeout(topicsLoading);
  topicsLoading = setTimeout(async () => {
    try {
      const tree = await loadTopics(project);
      if (project !== activeProject()?.id) return;
      topicsTree = tree;
    } catch (cause) {
      topicsTree = { threads: [], loose_turns: [], failure: cause.message };
    }
    renderHistory();
  }, 300);
}

/** A topic edit is a record_topic call; it settles before the form closes. */
async function declareTopic(args) {
  const entry = startCall(
    "record_topic",
    args,
    activeProject()?.id,
    scheduleRender,
  );
  state.history.unshift(entry);
  scheduleRender();
  await entry.done;
  if (entry.outcome !== "ok")
    throw new Error(entry.failure ?? "The declaration failed.");
  reloadTopics();
}

function renderTopicsView() {
  const json = JSON.stringify(topicsTree ?? null);
  if (json === topicsDrawn) return;
  topicsDrawn = json;
  renderTopics(document.getElementById("topics-view"), topicsTree, {
    onOpen: openEarlier,
    onDeclare: declareTopic,
    callName: (historyId) =>
      state.history.find((entry) => entry.historyId === historyId)?.name,
  });
}

const renderHistory = () => {
  const topics = state.source === "topics";
  document.getElementById("topics-view").hidden = !topics;
  document.getElementById("history-list").hidden = topics;
  document.getElementById("history-older").hidden =
    topics || olderHistory === undefined;
  document.getElementById("history-empty").hidden =
    topics || state.history.length > 0;
  if (topics) {
    renderTopicsView();
    return;
  }
  document.getElementById("clear-history").hidden = !state.history.some(
    (entry) => !isLive(entry),
  );
  drawHistory(
    state.history.filter(
      (entry) =>
        state.source === "all" ||
        (entry.source ?? "workbench") === state.source,
    ),
    { shown: state.shown, onCancel: cancelCall, onSelect: showCall },
  );
};

// Every turn's nested calls, opened or folded in one go, in either view.
let callsExpanded = false;
document.getElementById("fold-calls").addEventListener("click", (event) => {
  callsExpanded = !callsExpanded;
  event.currentTarget.textContent = callsExpanded ? "Fold all" : "Expand all";
  setTurnsExpanded(callsExpanded, state.history);
  setTopicsExpanded(callsExpanded, topicsTree);
  topicsDrawn = undefined;
  renderHistory();
});

document.getElementById("history-filter").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-source]");
  if (!button) return;
  setSource(button.dataset.source);
  saveView();
});

function setSource(source) {
  state.source = source;
  for (const button of document.querySelectorAll("#history-filter button"))
    button.setAttribute(
      "aria-pressed",
      String(button.dataset.source === source),
    );
  renderHistory();
  reloadTopics();
}

/** Loads the active project's history, keeping this page's calls in flight. */
async function loadHistory() {
  const project = activeProject()?.id;
  const [{ entries: stored, next }, usage] = await Promise.all([
    loadStoredHistory(project),
    loadToolUsage(project),
  ]);
  if (project !== activeProject()?.id) return;
  state.usage = usage;
  renderCatalog();
  olderHistory = next;
  const live = state.history.filter(
    (entry) => !entry.stored && isLive(entry) && entry.project === project,
  );
  const known = new Set(live.map((entry) => entry.historyId));
  state.history = [
    ...live,
    ...stored.filter((entry) => !known.has(entry.historyId)),
  ].sort((a, b) => b.startedAt - a.startedAt);
  if (state.shown && !state.history.includes(state.shown)) {
    state.shown = undefined;
    document.getElementById("result-view").replaceChildren();
  }
  renderHistory();
  renderWorkflow();
  reloadTopics();
}

/** Appends the next, older page of history to the list. */
async function loadOlderHistory() {
  const project = activeProject()?.id;
  const page = olderHistory;
  if (!page) return;
  const { entries, next } = await loadStoredHistory(project, page);
  if (project !== activeProject()?.id || page !== olderHistory) return;
  olderHistory = next;
  const known = new Set(state.history.map((entry) => entry.historyId));
  state.history = [
    ...state.history,
    ...entries.filter((entry) => !known.has(entry.historyId)),
  ].sort((a, b) => b.startedAt - a.startedAt);
  renderHistory();
  reloadTopics();
}

document
  .getElementById("history-older")
  .addEventListener("click", () => void loadOlderHistory());

/**
 * A call the bridge recorded or an agent started. This page's own calls
 * already have their result and only gain their confirmed Evidence links.
 */
function mergeBridgeEntry({ project, entry: summary }) {
  const active = activeProject()?.id ?? null;
  if (project !== active) return;
  // The bridge sends a call once history has stored it; a running agent call
  // isn't stored yet.
  if (summary.outcome !== "running" && state.usage) {
    countToolUse(state.usage, summary);
    catalogStale = true;
  }
  const index = state.history.findIndex(
    (entry) => entry.historyId === summary.id,
  );
  const known = index === -1 ? undefined : state.history[index];
  if (known && !known.stored) {
    known.links = summary.links;
    // Only the parts showing links change: the history list on the right and
    // the result's link line. The result itself keeps its tab and scroll.
    if (state.shown === known) updateLinks(known, openEarlier);
    scheduleRender();
    return;
  }
  const entry = fromBridge(summary, project ?? undefined);
  if (known) state.history[index] = entry;
  else {
    state.history.unshift(entry);
    state.history.sort((a, b) => b.startedAt - a.startedAt);
  }
  if (known && state.shown === known) {
    state.shown = entry;
    void loadStoredResult(entry).then(() => renderShown(true));
  }
  scheduleRender();
}

// Right-hand tabs: History and Project (the active folder).
function showSideTab(name) {
  for (const tab of ["history", "project"]) {
    document
      .getElementById(`tab-${tab}`)
      .setAttribute("aria-selected", String(tab === name));
    document.getElementById(`panel-${tab}`).hidden = tab !== name;
  }
  if (name === "project") void projects?.refresh();
  saveView();
}
for (const tab of ["history", "project"])
  document
    .getElementById(`tab-${tab}`)
    .addEventListener("click", () => showSideTab(tab));

let confirmClear;
document
  .getElementById("clear-history")
  .addEventListener("click", async (event) => {
    const button = event.currentTarget;
    // Stored history is removed for good, so it takes a second click.
    if (!confirmClear) {
      button.textContent = "Confirm clear";
      confirmClear = setTimeout(() => {
        confirmClear = undefined;
        button.textContent = "Clear";
      }, 4000);
      return;
    }
    clearTimeout(confirmClear);
    confirmClear = undefined;
    button.textContent = "Clear";
    await clearStoredHistory(activeProject()?.id);
    state.history = state.history.filter(isLive);
    state.usage = new Map();
    renderCatalog();
    if (state.shown && !isLive(state.shown)) {
      state.shown = undefined;
      document.getElementById("result-view").replaceChildren();
    }
    renderHistory();
    renderWorkflow();
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
  // The first catalog event loads the catalog; later ones reload it.
  void followCatalog();
  projects ??= initProjects({
    onChange: () => {
      agent?.projectChanged();
      historyLoading = loadHistory();
    },
    onShowProjects: () => showSideTab("project"),
    onOpenAssessment: showAssessmentView,
  });
  const terminal = await apiJson("/api/terminal").catch(() => ({}));
  await projects.restore(terminal.running ? terminal.project : undefined);
  agent ??= await initAgent({
    host: document.getElementById("agent-controls"),
    getProject: activeProject,
    onState: (session) =>
      void projects.lock(session.running ? session.project : undefined),
    onStarted: showAgentView,
  }).catch((cause) => {
    document.getElementById("agent-controls").textContent =
      `The agent controls couldn't load: ${cause.message}`;
    return undefined;
  });
  await restoreView();
  void refreshDoctor().catch(() => {});
  startPageLog();
}

onTokenRejected(showTokenGate);
if (readToken()) void boot();
else showTokenGate();
setInterval(() => {
  if (getToken() && !document.hidden) void refreshStatus();
}, 15_000);

// ---------------------------------------------------------------------------
// Page lifecycle log (frontend/.workbench-page.log): why this page loaded,
// how the one before it ended, and a heartbeat with memory every 30 s.

const BEAT_KEY = "rea-heartbeat";
const pageStartedAt = performance.now();

function pageReport(event, extra = {}) {
  if (!getToken()) return;
  void api("/api/page-log", {
    method: "POST",
    body: JSON.stringify({ event, ...extra }),
    keepalive: true,
  }).catch(() => {});
}

function heartbeat() {
  const memory = performance.memory;
  const beat = {
    heap: memory?.usedJSHeapSize,
    heapLimit: memory?.jsHeapSizeLimit,
    nodes: document.getElementsByTagName("*").length,
    history: state.history.length,
    visibility: document.visibilityState,
    view: state.selected?.kind ?? null,
    uptimeMs: Math.round(performance.now() - pageStartedAt),
  };
  try {
    sessionStorage.setItem(
      BEAT_KEY,
      JSON.stringify({ at: Date.now(), ...beat }),
    );
  } catch {
    // The log still gets the beat.
  }
  return beat;
}

function previousBeat() {
  try {
    return JSON.parse(sessionStorage.getItem(BEAT_KEY) ?? "null") ?? undefined;
  } catch {
    return undefined;
  }
}

const beforeThisPage = previousBeat();
function startPageLog() {
  pageReport("load", {
    navigation: performance.getEntriesByType("navigation")[0]?.type,
    wasDiscarded: document.wasDiscarded === true,
    previous: beforeThisPage ?? null,
    ...heartbeat(),
  });
  setInterval(() => pageReport("beat", heartbeat()), 30_000);
  for (const event of ["freeze", "resume", "pagehide", "visibilitychange"])
    document.addEventListener(event, () => pageReport(event, heartbeat()));
  window.addEventListener("error", (event) =>
    pageReport("error", { message: String(event.message).slice(0, 500) }),
  );
  window.addEventListener("unhandledrejection", (event) =>
    pageReport("error", {
      message: String(event.reason?.message ?? event.reason).slice(0, 500),
    }),
  );
}
