import {
  h,
  isEvidence,
  payloadOf,
  renderContent,
  renderError,
  renderProvenance,
  renderTree,
} from "./render.js";

/** Outcome line: tool name, outcome, elapsed time, and target-content marker. */
function runLine(entry, actions) {
  const elapsed =
    entry.elapsedMs === undefined
      ? ""
      : `${(entry.elapsedMs / 1000).toFixed(2)} s`;
  const outcomeLabel = entry.cancelled
    ? "Cancelled"
    : entry.outcome === "ok"
      ? "Completed"
      : "Failed";
  return h(
    "div",
    { class: "run-line" },
    h("strong", {}, entry.name),
    h(
      "span",
      { class: entry.outcome === "ok" ? "" : "outcome-error" },
      outcomeLabel,
    ),
    h("span", {}, elapsed),
    entry.result?._meta?.provenance?.untrusted_content
      ? h(
          "span",
          {
            class: "untrusted",
            title:
              "Strings in this result come from the analysis target and are shown as inert text.",
          },
          "Contains target content",
        )
      : null,
    actions,
  );
}

/** Result views, most specific first. */
function resultTabs(result, payload, onEvidenceLink) {
  const tabs = [];
  if (result.isError) {
    tabs.push([
      "Error",
      () => [
        renderError(
          payload,
          (result.content ?? []).map((block) => block.text ?? "").join("\n"),
        ),
      ],
    ]);
  } else if (isEvidence(payload)) {
    tabs.push([
      "Evidence",
      () => [
        renderProvenance(payload, onEvidenceLink),
        renderTree(payload.normalized_result, {
          onEvidenceLink: onEvidenceLink,
          openDepth: 2,
        }),
      ],
    ]);
  }
  if (payload !== undefined)
    tabs.push([
      "Structured",
      () => [
        renderTree(payload, { onEvidenceLink: onEvidenceLink, openDepth: 1 }),
      ],
    ]);
  tabs.push(["Content", () => renderContent(result)]);
  tabs.push([
    "Raw result",
    () => [
      renderTree(result, { onEvidenceLink: onEvidenceLink, openDepth: 1 }),
    ],
  ]);
  return tabs;
}

/** Renders one finished call into the result view. */
export function showEntry(entry, onEvidenceLink) {
  const resultView = document.getElementById("result-view");
  const actions = h("div", { class: "result-tools" });
  const line = runLine(entry, actions);

  if (!entry.result) {
    resultView.replaceChildren(line, renderError(undefined, entry.failure));
    return;
  }

  const result = entry.result;
  const payload = payloadOf(result);
  const tabs = resultTabs(result, payload, onEvidenceLink);

  actions.append(
    h(
      "button",
      {
        type: "button",
        class: "quiet",
        onclick: () =>
          navigator.clipboard?.writeText(
            JSON.stringify(payload ?? result, null, 2),
          ),
      },
      "Copy JSON",
    ),
    h(
      "button",
      {
        type: "button",
        class: "quiet",
        onclick: () => download(entry, payload ?? result),
      },
      "Download JSON",
    ),
  );

  const body = h("div");
  const switcher = h("div", { class: "mode-switch result-tabs" });
  const select = (index) => {
    [...switcher.children].forEach((button, buttonIndex) =>
      button.setAttribute("aria-pressed", String(buttonIndex === index)),
    );
    body.replaceChildren(...tabs[index][1]());
  };
  tabs.forEach(([label], index) =>
    switcher.append(
      h(
        "button",
        {
          type: "button",
          "aria-pressed": "false",
          onclick: () => select(index),
        },
        label,
      ),
    ),
  );
  resultView.replaceChildren(line, switcher, body);
  select(0);
  resultView.scrollIntoView({
    block: "start",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth",
  });
}

function download(entry, value) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = h("a", {
    href: url,
    download: `${entry.name}-${new Date(entry.startedAt).toISOString().replace(/[:.]/g, "-")}.json`,
  });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Renders call history; onSelect restores a finished entry. */
export function renderHistory(history, onSelect) {
  const list = document.getElementById("history-list");
  document.getElementById("history-empty").hidden = history.length > 0;
  list.replaceChildren(
    ...history.slice(0, 50).map((entry) =>
      h(
        "li",
        { "data-outcome": entry.outcome },
        h(
          "button",
          {
            type: "button",
            title: "Show this result and restore its arguments",
            onclick: () => {
              if (entry.outcome !== "running") void onSelect(entry);
            },
          },
          h("span", { class: "h-name" }, entry.name),
          h(
            "span",
            { class: "h-meta" },
            new Date(entry.startedAt).toLocaleTimeString(),
            entry.elapsedMs === undefined
              ? ""
              : `, ${(entry.elapsedMs / 1000).toFixed(1)} s`,
          ),
        ),
      ),
    ),
  );
}
