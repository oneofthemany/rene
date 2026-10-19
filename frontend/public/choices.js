// "What you use": switches for each provider and tool, and the default
// analysis engine. The bridge saves both; turned-off items aren't offered
// for install and their checks don't count as "to fix".

import { apiJson } from "./api.js";
import { h, renderError } from "./render.js";

const AUTO_LABEL = "Let REA choose (it asks when several engines fit)";

/** Whether rea doctor found an engine usable. */
function engineReady(id, report) {
  if (id === "hopper")
    return report.checks?.find((check) => check.name === "hopper")?.ok;
  return report.providerInspections?.find((p) => p.id === id)?.available;
}

function switchRow(choice, used) {
  const box = h("input", {
    type: "checkbox",
    id: `use-${choice.id}`,
    checked: used,
  });
  return {
    box,
    element: h(
      "div",
      { class: "choice" },
      box,
      h(
        "label",
        { for: box.id },
        h("strong", {}, choice.label),
        h("span", { class: "help" }, choice.purpose),
      ),
    ),
  };
}

function engineSelect(described, report) {
  const select = h("select", { id: "default-engine" });
  const options = [
    h("option", { value: "auto" }, AUTO_LABEL),
    ...described.choices
      .filter((choice) => choice.engine)
      .map((choice) =>
        h(
          "option",
          { value: choice.id },
          engineReady(choice.id, report)
            ? choice.label
            : `${choice.label} (not ready)`,
        ),
      ),
  ];
  select.append(...options);
  select.value = described.engine;
  return select;
}

/**
 * Renders the section. `report` is the latest rea doctor report; onSaved
 * runs after the choices are saved (and REA restarted, if needed).
 */
export async function renderChoices({ report, onSaved }) {
  const area = h("section", { class: "choices" });
  let described;
  try {
    described = await apiJson("/api/choices");
  } catch (cause) {
    area.replaceChildren(renderError(undefined, cause.message));
    return area;
  }
  const rows = new Map();
  const groups = new Map();
  for (const choice of described.choices) {
    const row = switchRow(choice, described.use[choice.id]);
    rows.set(choice.id, row);
    if (!groups.has(choice.group)) groups.set(choice.group, []);
    groups.get(choice.group).push(row.element);
  }
  const select = engineSelect(described, report);
  const message = h("span", { class: "form-error", role: "alert" });

  // An engine that is off can't be the default.
  function syncEngines() {
    for (const option of select.options) {
      if (option.value === "auto") continue;
      option.disabled = !rows.get(option.value).box.checked;
    }
    if (select.selectedOptions[0]?.disabled) {
      message.textContent = `The default engine is now "Let REA choose", because ${select.selectedOptions[0].textContent.replace(/ \(not ready\)$/, "")} is off.`;
      select.value = "auto";
    }
  }
  for (const row of rows.values())
    row.box.addEventListener("change", syncEngines);
  syncEngines();

  const save = h(
    "button",
    { type: "submit", class: "primary" },
    "Save choices",
  );
  async function submit() {
    save.disabled = true;
    save.textContent = "Saving…";
    try {
      await apiJson("/api/choices", {
        method: "POST",
        body: JSON.stringify({
          use: Object.fromEntries(
            [...rows].map(([id, row]) => [id, row.box.checked]),
          ),
          engine: select.value,
        }),
      });
      await onSaved();
    } catch (cause) {
      message.textContent = cause.message;
      save.disabled = false;
      save.textContent = "Save choices";
    }
  }

  area.replaceChildren(
    h("h3", {}, "What you use"),
    h(
      "p",
      { class: "hint" },
      "Turn off what you don't need: it isn't offered for install and doesn't count as something to fix. Nothing is uninstalled.",
    ),
    h(
      "form",
      { onsubmit: (event) => (event.preventDefault(), void submit()) },
      [...groups].map(([group, elements]) =>
        h(
          "fieldset",
          { class: "choice-group" },
          h("legend", {}, group),
          elements,
        ),
      ),
      h(
        "div",
        { class: "field" },
        h("label", { for: select.id }, "Default analysis engine"),
        select,
        h(
          "p",
          { class: "help" },
          described.engineSource === "shell"
            ? "Currently set by the shell the workbench started in; saving here takes precedence."
            : "Used when a native program could be opened by more than one engine. Agents pick it up the next time you run Agent setup.",
        ),
      ),
      h("div", { class: "actions" }, save, message),
    ),
  );
  return area;
}
