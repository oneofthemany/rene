import {
  h,
  isEvidence,
  payloadOf,
  renderContent,
  renderError,
  renderProvenance,
  renderTree,
} from "./render.js";
import { isLive, liveStatus } from "./calls.js";

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
    resultView.replaceChildren(
      line,
      entry.cancelled
        ? h(
            "p",
            { class: "hint" },
            "You cancelled this call before it returned a result.",
          )
        : renderError(undefined, entry.failure),
    );
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

/** Renders an in-flight call: status, progress, and its own Cancel. */
export function showLive(entry, onCancel) {
  const progress = h("progress", { "aria-label": "Progress" });
  if (typeof entry.progress?.total === "number") {
    progress.max = entry.progress.total;
    progress.value = entry.progress.value;
  }
  document.getElementById("result-view").replaceChildren(
    h(
      "div",
      { class: "run-line" },
      h("strong", {}, entry.name),
      entry.outcome === "running" ? progress : null,
      h("span", {}, liveStatus(entry)),
      h(
        "button",
        {
          type: "button",
          class: "quiet",
          disabled: entry.cancelRequested,
          onclick: () => onCancel(entry),
        },
        "Cancel",
      ),
    ),
  );
}

/** Renders call history; onSelect shows an entry, onCancel stops a live one. */
export function renderHistory(history, { onSelect, onCancel, shown }) {
  const live = history.filter(isLive).length;
  document.getElementById("history-title").textContent = live
    ? `History, ${live} in progress`
    : "History";
  document.getElementById("history-empty").hidden = history.length > 0;
  document.getElementById("history-list").replaceChildren(
    ...history.slice(0, 50).map((entry) =>
      h(
        "li",
        {
          "data-outcome": entry.outcome,
          "aria-current": String(entry === shown),
        },
        h(
          "button",
          {
            type: "button",
            class: "h-open",
            title: "Show this call and restore its arguments",
            onclick: () => void onSelect(entry),
          },
          h("span", { class: "h-name" }, entry.name),
          h(
            "span",
            { class: "h-meta" },
            isLive(entry)
              ? liveStatus(entry)
              : [
                  new Date(entry.startedAt).toLocaleTimeString(),
                  entry.elapsedMs === undefined
                    ? ""
                    : `, ${(entry.elapsedMs / 1000).toFixed(1)} s`,
                ],
          ),
        ),
        isLive(entry)
          ? h(
              "button",
              {
                type: "button",
                class: "h-cancel",
                disabled: entry.cancelRequested,
                "aria-label": `Cancel ${entry.name}`,
                onclick: () => void onCancel(entry),
              },
              "Cancel",
            )
          : null,
      ),
    ),
  );
}
