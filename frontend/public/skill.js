// Agent skill view. `rene skill` decides where each agent reads skills, what
// is installed and whether it is current, and installs atomically with
// backups; this view shows its status and asks it to install.

import { apiJson } from "./api.js";
import { h, renderError } from "./render.js";

/** Opens the skill view in `container`. */
export async function showSkill(container) {
  container.replaceChildren(
    h("p", { class: "hint" }, "Asking rene which agents have the skill…"),
  );
  let status;
  try {
    status = await apiJson("/api/skill");
  } catch (cause) {
    container.replaceChildren(renderError(undefined, cause.message));
    return;
  }
  render(container, status);
}

const summary = (status) =>
  !status.installed
    ? "Not installed for any agent yet."
    : status.current
      ? `Installed and current (version ${status.version}).`
      : `Installed copies differ from this build's skill (installed version ${status.version ?? "unknown"}); Install updates them.`;

function render(container, status, notice) {
  const installed = new Map(
    status.destinations.map(({ client, path }) => [client, path]),
  );
  const chosen = new Set();
  const rows = status.folders.map(({ client, directory }) => {
    const has = installed.has(client);
    const box = h("input", {
      type: "checkbox",
      "aria-label": `Install the skill for ${client}`,
    });
    // Shared and folders that have it are always kept current.
    if (has || client === "shared") {
      box.checked = true;
      box.disabled = true;
    }
    box.addEventListener("change", () => {
      if (box.checked) chosen.add(client);
      else chosen.delete(client);
    });
    return h(
      "tr",
      {},
      h("td", {}, box),
      h("td", {}, client === "shared" ? "shared (most agents)" : client),
      h("td", {}, has ? "Installed" : "Not installed"),
      h("td", {}, h("code", {}, directory)),
    );
  });
  const result = h("div", { "aria-live": "polite" }, notice ?? "");
  const install = h(
    "button",
    { type: "button", class: "primary" },
    status.installed ? "Install / update" : "Install",
  );
  install.addEventListener("click", async () => {
    install.disabled = true;
    result.replaceChildren(h("p", { class: "hint" }, "Installing…"));
    try {
      const report = await apiJson("/api/skill/install", {
        method: "POST",
        body: JSON.stringify({ clients: [...chosen] }),
      });
      render(
        container,
        report,
        h(
          "p",
          { class: "hint" },
          report.result === "unchanged"
            ? "Already current; nothing was changed."
            : "Installed. Restart a running agent to load it.",
        ),
      );
    } catch (cause) {
      install.disabled = false;
      result.replaceChildren(renderError(undefined, cause.message));
    }
  });
  container.replaceChildren(
    h(
      "section",
      { class: "setup" },
      h("h2", {}, "Agent skill"),
      h(
        "p",
        { class: "hint" },
        "The reverse-engineer-anything skill tells agents how to analyse targets with rene (rene call in their shell). rene skill installs it into each agent's own skill folder, keeps unrelated files, and backs up anything it replaces. Agents reach rene without registering it anywhere.",
      ),
      h("p", {}, summary(status)),
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
              h("th", { scope: "col" }, "Install"),
              h("th", { scope: "col" }, "Skill folder"),
              h("th", { scope: "col" }, "Status"),
              h("th", { scope: "col" }, "Path"),
            ),
          ),
          h("tbody", {}, rows),
        ),
      ),
      h("div", { class: "actions setup-actions" }, install),
      result,
    ),
  );
}
