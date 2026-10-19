// Provider paths form. The bridge validates and saves the paths, adds them to
// REA's environment and restarts REA; rea doctor then says whether each
// provider is ready.

import { apiJson } from "./api.js";
import { openPicker } from "./browse.js";
import { h, renderError } from "./render.js";

const sourceNote = (setting) =>
  setting.saved && setting.shell && setting.saved !== setting.shell
    ? `Saved here; replaces ${setting.shell} from your shell.`
    : setting.saved
      ? "Saved here."
      : setting.shell
        ? "From the shell the workbench started in."
        : "Not set.";

/** Whether rea doctor found the provider behind a setting usable. */
/**
 * Whether rea doctor found the provider behind a setting usable, or "unused"
 * when the user turned that provider off.
 */
function readiness(setting, report, unusedChoices) {
  if (unusedChoices.includes(setting.inspection ?? setting.check))
    return "unused";
  if (setting.inspection) {
    const inspection = report.providerInspections?.find(
      (candidate) => candidate.id === setting.inspection,
    );
    return inspection?.available;
  }
  return report.checks?.find((check) => check.name === setting.check)?.ok;
}

function pathRow(setting, ready) {
  const input = h("input", {
    id: `setting-${setting.name}`,
    spellcheck: "false",
    autocomplete: "off",
    placeholder: setting.kind === "dir" ? "/path/to/folder" : "/path/to/file",
  });
  input.value = setting.saved || setting.shell;
  input.dataset.initial = input.value;
  const browse = h(
    "button",
    {
      type: "button",
      class: "quiet",
      "aria-label": `Browse for ${setting.label}`,
      onclick: () =>
        openPicker({
          start: input.value || undefined,
          folder: setting.kind === "dir",
          onPick: (path) => {
            input.value = path;
          },
        }),
    },
    "Browse…",
  );
  return {
    input,
    element: h(
      "div",
      { class: "field provider-path" },
      h(
        "label",
        { for: input.id },
        setting.label,
        " ",
        h("code", {}, setting.name),
        ready === undefined
          ? null
          : h(
              "span",
              {
                class:
                  ready === "unused"
                    ? "doctor-state-unused"
                    : ready
                      ? "doctor-state-ready"
                      : "doctor-state-problem",
              },
              ready === "unused" ? "Not used" : ready ? "Ready" : "Not ready",
            ),
      ),
      h("div", { class: "path-control" }, input, browse),
      h("p", { class: "help" }, sourceNote(setting)),
    ),
  };
}

/**
 * Renders the form. `report` is the latest rea doctor report; onSaved
 * runs after REA has restarted with the new paths.
 */
export async function renderProviderPaths({
  report,
  onSaved,
  unusedChoices = [],
}) {
  const area = h("section", { class: "provider-paths" });
  let described;
  try {
    described = await apiJson("/api/settings");
  } catch (cause) {
    area.replaceChildren(renderError(undefined, cause.message));
    return area;
  }
  // The default engine is chosen under "What you use", not as a path.
  const rows = described.settings
    .filter((setting) => setting.kind !== "choice")
    .map((setting) => ({
      setting,
      ...pathRow(setting, readiness(setting, report, unusedChoices)),
    }));
  const formError = h("span", { class: "form-error", role: "alert" });
  const save = h(
    "button",
    { type: "submit", class: "primary" },
    "Save and restart REA",
  );
  let confirmRunning = false;

  async function submit() {
    const values = {};
    for (const { setting, input } of rows) {
      const value = input.value.trim();
      // Unchanged fields are left alone, so a shell value is never copied
      // into the saved file just by saving another path.
      if (value !== input.dataset.initial) values[setting.name] = value;
    }
    if (Object.keys(values).length === 0) {
      formError.textContent = "Nothing changed.";
      return;
    }
    // Restarting REA cancels calls in flight, from any page.
    const status = await apiJson("/api/status");
    const running = status.activeCalls?.length ?? 0;
    if (running && !confirmRunning) {
      confirmRunning = true;
      save.textContent = "Save and cancel running calls";
      formError.textContent = `${running} ${running === 1 ? "call is" : "calls are"} running. Restarting REA cancels ${running === 1 ? "it" : "them"}. Click again to save.`;
      return;
    }
    confirmRunning = false;
    formError.textContent = "";
    save.disabled = true;
    save.textContent = "Saving and restarting REA…";
    try {
      await apiJson("/api/settings", {
        method: "POST",
        body: JSON.stringify({ values }),
      });
      await onSaved();
    } catch (cause) {
      formError.textContent = cause.message;
      save.disabled = false;
      save.textContent = "Save and restart REA";
    }
  }

  // Optional parts are null; replaceChildren would print them as "null".
  const parts = [
    h("h3", {}, "Provider paths"),
    h(
      "p",
      { class: "hint" },
      `Point REA at providers you installed yourself, or change where it finds them. Paths are saved in ${described.path} and added to REA's environment. Clear a field to go back to your shell's value.`,
    ),
    described.loadError ? renderError(undefined, described.loadError) : null,
    h(
      "form",
      { onsubmit: (event) => (event.preventDefault(), void submit()) },
      h(
        "div",
        { class: "fields" },
        rows.map((row) => row.element),
      ),
      h("div", { class: "actions" }, save, formError),
    ),
  ];
  area.replaceChildren(...parts.filter(Boolean));
  return area;
}
