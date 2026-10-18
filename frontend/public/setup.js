// Agent registration view. `rea setup` decides what is detected, what a
// registration changes and where backups go; this view shows its plan and
// applies it only after a second, deliberate click.

import { api, apiJson } from "./api.js";
import { h, renderError } from "./render.js";

const STATUS_TEXT = {
  configured: "Registered",
  needs_configuration: "Detected, not registered",
  missing: "Not detected",
};
const REGISTRATION_TEXT = {
  aligned: "current",
  current: "current",
  stale: "differs from what setup would register",
  missing: "none",
};

/** Opens the registration view in `container`. */
export async function showSetup(container) {
  container.replaceChildren(
    h("p", { class: "hint" }, "Asking rea setup what it can register…"),
  );
  let status;
  try {
    status = await apiJson("/api/setup/plan", {
      method: "POST",
      body: JSON.stringify({ clients: [] }),
    });
  } catch (cause) {
    container.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  render(container, status.report);
}

function registrationsByClient(report) {
  const out = new Map();
  for (const entry of report.doctor?.identity?.registrations ?? [])
    out.set(entry.client, entry);
  return out;
}

function render(container, report) {
  const registrations = registrationsByClient(report);
  const states = report.clientStates ?? [];
  const selected = new Set(
    states
      .filter((state) => state.status === "needs_configuration")
      .map((state) => state.client.name),
  );
  const planArea = h("div", { class: "setup-plan", "aria-live": "polite" });
  const preview = h(
    "button",
    { type: "button", class: "primary" },
    "Preview changes",
  );

  const row = (state) => {
    const { name, displayName, configPath } = state.client;
    const registration = registrations.get(name);
    const box = h("input", {
      type: "checkbox",
      "aria-label": `Register with ${displayName ?? name}`,
      checked: selected.has(name),
      onchange: (event) => {
        if (event.target.checked) selected.add(name);
        else selected.delete(name);
        planArea.replaceChildren();
      },
    });
    return h(
      "tr",
      { class: state.detected ? undefined : "setup-undetected" },
      h("td", {}, box),
      h("td", {}, displayName ?? name),
      h(
        "td",
        {},
        // Setup counts only its own exact command as registered.
        registration?.state === "stale"
          ? "Registered with a different command"
          : (STATUS_TEXT[state.status] ?? state.status),
      ),
      h(
        "td",
        {},
        registration
          ? h(
              "span",
              {
                class: `setup-reg setup-reg-${registration.state === "aligned" ? "current" : registration.state}`,
              },
              REGISTRATION_TEXT[registration.state] ?? registration.state,
            )
          : "",
        registration?.command?.length
          ? h(
              "code",
              { class: "setup-command" },
              registration.command.join(" "),
            )
          : "",
      ),
      h("td", {}, h("code", { class: "setup-path" }, configPath)),
    );
  };
  const detected = states.filter((state) => state.detected).map(row);
  // Undetected agents are one click away, so an agent not yet run can be registered.
  const undetected = states.filter((state) => !state.detected).map(row);
  const others = h("tbody", { hidden: true }, undetected);
  const toggle = h(
    "button",
    { type: "button", class: "link", "aria-expanded": "false" },
    `Show ${undetected.length} agents not detected on this machine`,
  );
  toggle.addEventListener("click", () => {
    others.hidden = !others.hidden;
    toggle.setAttribute("aria-expanded", String(!others.hidden));
    toggle.textContent = others.hidden
      ? `Show ${undetected.length} agents not detected on this machine`
      : "Hide agents not detected on this machine";
  });

  preview.addEventListener(
    "click",
    () => void showPlan(planArea, [...selected]),
  );

  container.replaceChildren(
    h(
      "section",
      { class: "setup" },
      h("h2", {}, "Register REA with your agents"),
      h(
        "p",
        { class: "hint" },
        "rea setup adds this REA build as an MCP server in each selected agent's own configuration, keeps unrelated settings, and backs up any file it changes. REA_* provider settings in the environment this workbench was started from are registered with it.",
      ),
      h(
        "div",
        { class: "setup-table-wrap" },
        h(
          "table",
          { class: "setup-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              h(
                "th",
                { scope: "col" },
                h("span", { class: "visually-hidden" }, "Select"),
              ),
              h("th", { scope: "col" }, "Agent"),
              h("th", { scope: "col" }, "Status"),
              h("th", { scope: "col" }, "Current registration"),
              h("th", { scope: "col" }, "Configuration"),
            ),
          ),
          h("tbody", {}, detected),
          others,
        ),
      ),
      undetected.length > 0 ? h("p", {}, toggle) : "",
      h("div", { class: "actions setup-actions" }, preview),
      planArea,
    ),
  );
}

async function showPlan(area, clients) {
  if (clients.length === 0) {
    area.replaceChildren(
      h(
        "div",
        { class: "actions" },
        h("p", { class: "form-error" }, "Select at least one agent."),
      ),
    );
    return;
  }
  area.replaceChildren(h("p", { class: "hint" }, "Planning…"));
  let plan;
  try {
    plan = await apiJson("/api/setup/plan", {
      method: "POST",
      body: JSON.stringify({ clients }),
    });
  } catch (cause) {
    area.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  renderPlan(area, clients, plan.report, plan.fingerprint);
}

function renderPlan(area, clients, report, fingerprint, notice) {
  const actions = report.plannedActions ?? [];
  if (report.status !== "planned" || actions.length === 0) {
    area.replaceChildren(
      notice ? h("p", { class: "form-error", role: "alert" }, notice) : "",
      h(
        "p",
        { class: "hint" },
        report.status === "planned"
          ? "Nothing to change: the selected agents are already registered."
          : `rea setup did not produce a plan (status: ${String(report.status)}).`,
      ),
    );
    return;
  }
  const message = h("p", { class: "form-error", role: "alert" }, notice ?? "");
  const apply = h(
    "button",
    { type: "button", class: "primary" },
    "Apply changes",
  );
  let confirming = false;
  apply.addEventListener("click", async () => {
    // Writing agent configuration needs a second, deliberate click.
    if (!confirming) {
      confirming = true;
      apply.textContent = "Confirm apply";
      message.textContent =
        "This edits the configuration files listed above. Click again to apply.";
      return;
    }
    apply.disabled = true;
    apply.textContent = "Applying…";
    await applyPlan(area, clients, fingerprint);
  });
  area.replaceChildren(
    h("h3", {}, "Planned changes"),
    h(
      "ol",
      { class: "setup-actions-list" },
      actions.map((action) =>
        h(
          "li",
          {},
          h("strong", {}, action.label),
          " ",
          h("span", { class: "setup-op" }, action.operation),
          h("div", {}, h("code", { class: "setup-path" }, action.target)),
          action.backupPath
            ? h(
                "div",
                { class: "hint" },
                "Backup: ",
                h("code", { class: "setup-path" }, action.backupPath),
              )
            : "",
          h("p", { class: "setup-detail" }, action.detail),
        ),
      ),
    ),
    h("div", { class: "actions setup-actions" }, apply, message),
  );
}

async function applyPlan(area, clients, fingerprint) {
  let response;
  let body;
  try {
    response = await api("/api/setup/apply", {
      method: "POST",
      body: JSON.stringify({ clients, fingerprint }),
    });
    body = await response.json();
  } catch (cause) {
    area.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  if (response.status === 409 && body.report) {
    renderPlan(area, clients, body.report, body.fingerprint, body.error);
    return;
  }
  if (!response.ok) {
    area.replaceChildren(
      renderError(
        undefined,
        body.error ?? `Request failed with ${response.status}.`,
      ),
    );
    return;
  }
  const report = body.report;
  const results = Object.entries(report.clients ?? {});
  area.replaceChildren(
    h(
      "h3",
      {},
      report.status === "ready"
        ? "Registered"
        : `Setup finished: ${String(report.status)}`,
    ),
    h(
      "ul",
      { class: "setup-actions-list" },
      results.map(([name, result]) =>
        h(
          "li",
          {},
          h("strong", {}, name),
          `: ${String(result.status)}`,
          result.backupPath
            ? h(
                "div",
                { class: "hint" },
                "Backup: ",
                h("code", { class: "setup-path" }, result.backupPath),
              )
            : "",
        ),
      ),
      (report.appliedActions ?? [])
        .filter((id) => !String(id).startsWith("configured_"))
        .map((id) => h("li", {}, String(id).replaceAll("_", " "))),
    ),
    h(
      "p",
      { class: "hint" },
      "Restart each agent so it loads the new registration.",
    ),
  );
}
