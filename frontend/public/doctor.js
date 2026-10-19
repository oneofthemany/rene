// Provider readiness view. `rea doctor` decides what is checked, what counts
// as ready and how to fix it; this view lays out its report.

import { apiJson } from "./api.js";
import { renderChoices } from "./choices.js";
import { renderInstallProviders } from "./installProviders.js";
import { renderProviderPaths } from "./providerPaths.js";
import { h, renderError } from "./render.js";

let latest;

/** Failing checks, leaving out providers and tools the user turned off. */
const toFix = ({ report, unused = [] }) =>
  (report.checks ?? []).filter(
    (check) => !check.ok && !unused.includes(check.name),
  );

/** Runs the doctor check and updates the header button with what needs fixing. */
export async function refreshDoctor() {
  const button = document.getElementById("open-providers");
  try {
    latest = await apiJson("/api/doctor");
  } catch (cause) {
    button.textContent = "Providers";
    button.title = cause.message;
    throw cause;
  }
  const failing = toFix(latest);
  button.textContent = failing.length
    ? `Providers, ${failing.length} to fix`
    : "Providers ready";
  button.title = failing.length
    ? `Not ready: ${failing.map((check) => check.name).join(", ")}`
    : "Everything you use is ready.";
  button.dataset.ready = latest.report.checks?.some((check) => check.ok)
    ? "some"
    : "none";
  return latest;
}

/** Opens the readiness view in `container`, reusing the last report if there is one. */
export async function showProviders(container, { recheck = false } = {}) {
  if (!latest || recheck) {
    container.replaceChildren(h("p", { class: "hint" }, "Running rea doctor…"));
    try {
      await refreshDoctor();
    } catch (cause) {
      container.replaceChildren(renderError(undefined, cause.message));
      return;
    }
  }
  await render(container, latest);
}

// Plain labels for doctor's classifications; others are shown as REA names them.
const STATE_TEXT = { missing_analysis_engine: "Not set up" };

const stateLabel = (check) =>
  check.ok
    ? "Ready"
    : (STATE_TEXT[check.classification] ??
      (check.classification ?? "Not ready").replace(/_/g, " "));

function checkRow(check, unused = []) {
  const notUsed = !check.ok && unused.includes(check.name);
  return h(
    "tr",
    {},
    h("td", {}, h("code", {}, check.name)),
    h(
      "td",
      {
        class: check.ok
          ? "doctor-state-ready"
          : notUsed
            ? "doctor-state-unused"
            : "doctor-state-problem",
      },
      notUsed ? "Not used" : stateLabel(check),
    ),
    // Some checks repeat their remediation as the detail; show it once.
    h("td", {}, check.detail === check.remediation ? "" : (check.detail ?? "")),
    h(
      "td",
      { class: "doctor-fix" },
      check.ok || notUsed ? "" : (check.remediation ?? ""),
    ),
  );
}

function table(headings, rows) {
  return h(
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
          headings.map((heading) => h("th", { scope: "col" }, heading)),
        ),
      ),
      h("tbody", {}, rows),
    ),
  );
}

async function render(
  container,
  { report, checkedAt, unused = [], unusedChoices = [] },
) {
  const checks = report.checks ?? [];
  const failing = toFix({ report, unused }).length;
  const providers = (report.providerInspections ?? []).filter(
    (provider) => provider.available,
  );
  const recheck = h(
    "button",
    {
      type: "button",
      class: "primary",
      onclick: () => void showProviders(container, { recheck: true }),
    },
    "Check again",
  );
  const recheckAll = () => showProviders(container, { recheck: true });
  const [choices, installs, paths] = await Promise.all([
    renderChoices({ report, onSaved: recheckAll }),
    renderInstallProviders({ onInstalled: recheckAll }),
    renderProviderPaths({ report, onSaved: recheckAll, unusedChoices }),
  ]);

  container.replaceChildren(
    h(
      "section",
      { class: "setup" },
      h("h2", {}, "Provider readiness"),
      h(
        "p",
        { class: "hint" },
        `rea doctor checked the settings REA runs with at ${new Date(checkedAt).toLocaleTimeString()}: your shell's environment plus any paths saved below.`,
      ),
      h(
        "p",
        {},
        failing
          ? `${failing} of ${checks.length} checks need attention. Tools that need a missing provider fail until it is set up.`
          : unused.length
            ? `Everything you use is ready. ${unused.length} ${unused.length === 1 ? "check is" : "checks are"} for things you turned off.`
            : `All ${checks.length} checks passed.`,
      ),
      choices,
      // Installing comes first: it fixes most failing checks in one step.
      installs,
      table(
        ["Check", "State", "Detail", "How to fix"],
        checks.map((check) => checkRow(check, unused)),
      ),
      providers.length
        ? table(
            ["Provider", "Version"],
            providers.map((provider) =>
              h(
                "tr",
                {},
                h("td", {}, h("code", {}, provider.id)),
                h("td", {}, provider.providerVersion ?? "unknown"),
              ),
            ),
          )
        : null,
      (report.informational_checks ?? []).length
        ? h(
            "details",
            {},
            h("summary", {}, "Other findings"),
            table(
              ["Check", "State", "Detail", "Note"],
              report.informational_checks.map((check) =>
                checkRow(check, unused),
              ),
            ),
          )
        : null,
      h("div", { class: "actions setup-actions" }, recheck),
      paths,
    ),
  );
}
