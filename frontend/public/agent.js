// Agent: the picker and Start/Stop in the project bar, and a terminal view
// attached to the bridge's agent session. The agent always starts in the
// active project's folder. The terminal is built once and kept, so switching
// to another view and back leaves the session and its screen as they were.

import { api, apiJson, ndjson } from "./api.js";
import { h } from "./render.js";

const AGENT_KEY = "rea-agent";
let panel;

const remember = (key, value) => {
  try {
    if (value === undefined) return localStorage.getItem(key) ?? undefined;
    localStorage.setItem(key, value);
  } catch {
    return undefined;
  }
};

/** Sends keystrokes in small batches, in order. */
function inputSender() {
  let pending = "";
  let sending = Promise.resolve();
  return (data) => {
    pending += data;
    sending = sending.then(async () => {
      if (!pending) return;
      const chunk = pending;
      pending = "";
      await api("/api/terminal/input", {
        method: "POST",
        body: JSON.stringify({ data: chunk }),
      }).catch(() => {});
    });
  };
}

async function createTerminal() {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("/vendor/xterm.mjs"),
    import("/vendor/addon-fit.mjs"),
  ]);
  const term = new Terminal({
    cursorBlink: true,
    fontFamily: "ui-monospace, 'JetBrains Mono', 'DejaVu Sans Mono', monospace",
    fontSize: 13,
    scrollback: 5000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  return { term, fit };
}

/** The agent picker: installed agents first, the rest disabled. */
function agentSelect(agents) {
  const select = h("select", {
    id: "agent-choice",
    "aria-describedby": "agent-choice-help",
  });
  const option = (agent) =>
    h(
      "option",
      { value: agent.id, disabled: !agent.installed },
      agent.installed ? agent.label : `${agent.label} (${agent.command})`,
    );
  for (const [label, installed] of [
    ["Installed", true],
    ["Not installed", false],
  ]) {
    const group = agents.filter((agent) => agent.installed === installed);
    if (group.length)
      select.append(h("optgroup", { label }, group.map(option)));
  }
  return { select, help: h("p", { class: "help", id: "agent-choice-help" }) };
}

/** How the chosen agent gets rene, and whether it can start. */
function connection(agent, registrations) {
  if (!agent.installed)
    return {
      ready: false,
      text: [
        `Not installed: \`${agent.command}\` isn't on the workbench's PATH. `,
        agent.install
          ? h(
              "a",
              { href: agent.install, target: "_blank", rel: "noreferrer" },
              `Get ${agent.label}`,
            )
          : undefined,
      ],
    };
  if (agent.rene === "session")
    return {
      ready: true,
      text: "rene is added for this session through the workbench, with its tools pre-approved. Every rea tool call it makes is recorded in the project's history.",
    };
  if (!registrations)
    return { ready: true, text: "Checking rene's registration…" };
  // The bridge checks again when the agent starts.
  if (registrations.error)
    return {
      ready: true,
      text: `Couldn't check rene's registration (${registrations.error}); Start checks it again.`,
    };
  const state = registrations[agent.client];
  if (state === "aligned")
    return {
      ready: true,
      text: `rene comes from its Agent setup registration (current). ${agent.label} asks before using its tools, as it normally does. Its tool calls go straight to REA, so they aren't recorded in the project's history.`,
    };
  return {
    ready: false,
    text: `rene isn't registered with ${agent.label}${state ? ` (${state})` : ""}. Register it in Agent setup, then come back.`,
  };
}

/** Agent picker, Start/Stop and status, reflecting the session and project. */
function controls(agents, getProject) {
  let registrations;
  const picker = agentSelect(agents);
  const label = (id) =>
    agents.find((agent) => agent.id === id)?.label ?? "The agent";
  const parts = {
    picker,
    start: h("button", { type: "button", class: "primary" }, "Start"),
    stop: h("button", { type: "button", class: "quiet" }, "Stop"),
    status: h("p", { class: "hint agent-status", role: "status" }),
    message: h("span", { class: "form-error", role: "alert" }),
    running: false,
    last: { running: false },
  };
  parts.registrations = (value) => {
    registrations = value;
    parts.show(parts.last);
  };
  parts.show = (state) => {
    parts.last = state;
    parts.running = state.running;
    if (state.agent) picker.select.value = state.agent;
    const chosen = agents.find((agent) => agent.id === picker.select.value);
    const link = chosen && connection(chosen, registrations);
    picker.help.replaceChildren(...[link?.text ?? ""].flat().filter(Boolean));
    const project = getProject();
    parts.start.disabled = state.running || !link?.ready || !project;
    parts.start.title = project ? "" : "Open a project folder first.";
    parts.stop.disabled = !state.running;
    picker.select.disabled = state.running;
    const name = label(state.agent ?? picker.select.value);
    parts.status.textContent = state.running
      ? `${name} is running in ${state.cwd}.`
      : state.exitCode !== undefined && state.exitCode !== null
        ? `${name} exited (code ${state.exitCode}). Start it again when you're ready.`
        : project
          ? `Not running. Start runs it in ${project.path}.`
          : "Not running. Open a project folder to start an agent in it.";
  };
  return parts;
}

/** Follows the session's stream; reconnects if it drops. */
async function follow(term, ui, onState) {
  let agent;
  const handle = (event) => {
    if (event.type === "state" || event.type === "started") {
      if (event.type === "started") term.reset();
      agent = event.agent ?? agent;
      ui.show(event);
      onState(event);
    } else if (event.type === "output") {
      if (event.replay) term.reset();
      term.write(event.data);
    } else if (event.type === "exit") {
      const state = { running: false, agent, exitCode: event.exitCode };
      ui.show(state);
      onState(state);
    }
  };
  for (;;) {
    try {
      const response = await api("/api/terminal/stream");
      for await (const event of ndjson(response.body)) handle(event);
    } catch {
      // The bridge restarted or the connection dropped; try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}

/** Keeps the session's size in step with the terminal on screen. */
function sizeKeeper(term, fit, screen, ui) {
  let size = "";
  return () => {
    if (!screen.isConnected) return;
    fit.fit();
    const next = `${term.cols}x${term.rows}`;
    if (next === size) return;
    size = next;
    if (ui.running)
      void api("/api/terminal/resize", {
        method: "POST",
        body: JSON.stringify({ cols: term.cols, rows: term.rows }),
      }).catch(() => {});
  };
}

/** The saved agent if it's installed, else the first installed one. */
function initialAgent(agents) {
  const saved = remember(AGENT_KEY);
  const usable = agents.filter((agent) => agent.installed);
  return (usable.find((agent) => agent.id === saved) ?? usable[0] ?? agents[0])
    ?.id;
}

/**
 * Builds the agent controls into `host` (the project bar) and follows the
 * session. getProject() is the active project; onState(state) hears every
 * session change; onStarted() runs after Start succeeds.
 */
export async function initAgent({ host, getProject, onState, onStarted }) {
  const [{ term, fit }, initial] = await Promise.all([
    createTerminal(),
    apiJson("/api/terminal"),
  ]);
  const screen = h("div", { class: "agent-screen" });
  const ui = controls(initial.agents, getProject);
  const send = inputSender();
  term.onData((data) => {
    if (ui.running) send(data);
  });
  const resize = sizeKeeper(term, fit, screen, ui);
  new ResizeObserver(resize).observe(screen);

  ui.picker.select.addEventListener("change", () => {
    remember(AGENT_KEY, ui.picker.select.value);
    ui.show({ running: false });
  });
  ui.start.onclick = async () => {
    ui.message.textContent = "";
    const project = getProject();
    if (!project) return;
    onStarted();
    if (!term.element) term.open(screen);
    fit.fit();
    try {
      const state = await apiJson("/api/terminal/start", {
        method: "POST",
        body: JSON.stringify({
          agent: ui.picker.select.value,
          cwd: project.path,
          cols: term.cols,
          rows: term.rows,
        }),
      });
      ui.show(state);
      onState(state);
      term.focus();
    } catch (cause) {
      ui.message.textContent = cause.message;
    }
  };
  ui.stop.onclick = () =>
    void apiJson("/api/terminal/stop", { method: "POST" }).catch((cause) => {
      ui.message.textContent = cause.message;
    });

  ui.picker.select.value = initial.agent ?? initialAgent(initial.agents);
  host.replaceChildren(
    h(
      "div",
      { class: "agent-pick" },
      h("label", { for: ui.picker.select.id }, "Agent"),
      ui.picker.select,
    ),
    h("div", { class: "agent-actions" }, ui.start, ui.stop),
    ui.message,
  );
  ui.show(initial);
  onState(initial);
  void follow(term, ui, onState);
  const loadRegistrations = () =>
    apiJson("/api/terminal/registrations")
      .then(ui.registrations)
      .catch((cause) => ui.registrations({ error: cause.message }));
  void loadRegistrations();

  const element = h(
    "section",
    { class: "agent" },
    h("h2", {}, "Agent terminal"),
    h(
      "p",
      { class: "hint" },
      "Your own coding agent, running on this computer in the project folder with rene connected as its rea tools. Your login, settings and other MCP servers still apply. REA can only see files in your home folder.",
    ),
    ui.picker.help,
    ui.status,
    screen,
  );
  return {
    /** Refreshes Start and the status after the active project changes. */
    projectChanged: () => ui.show(ui.last),
    /** Shows the terminal view in `container`. */
    show(container) {
      container.replaceChildren(element);
      // Registrations can change in Agent setup while the view is hidden.
      void loadRegistrations();
      if (!term.element) term.open(screen);
      requestAnimationFrame(() => {
        resize();
        term.focus();
      });
    },
  };
}
