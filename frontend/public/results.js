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
    (entry.result?._meta?.provenance?.untrusted_content ?? entry.untrusted)
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

/** Who ran a call: the agent (by name) or the person at the page. */
const sourceLabel = (entry) =>
  entry.source === "agent" ? (entry.agent ?? "Agent") : "You";

/**
 * Earlier calls whose Evidence this call named in its arguments, confirmed
 * by Evidence ID, and named Evidence no recorded call returned.
 */
function linkLine(entry, onLink) {
  if (!entry.links?.length) return h("p", { id: "result-links", hidden: true });
  return h(
    "p",
    {
      id: "result-links",
      class: "link-line",
      title:
        "This call's arguments name the Evidence ID (ev_<sha256>) these calls returned.",
    },
    "Uses Evidence from",
    entry.links.map((link) =>
      link.from === null
        ? h(
            "span",
            { title: link.evidence },
            `${link.arg}: Evidence no recorded call returned`,
          )
        : h(
            "button",
            {
              type: "button",
              class: "link",
              title: link.evidence,
              onclick: () => onLink(link.from),
            },
            `${link.tool} (${link.arg})`,
          ),
    ),
  );
}

const said = (event) =>
  event.kind === "action"
    ? h("li", { class: "said action" }, `Used ${event.tool}`)
    : h(
        "li",
        { class: `said ${event.kind}` },
        h(
          "span",
          { class: "said-kind" },
          event.kind === "reasoning" ? "Reasoning" : "Reply",
        ),
        h("span", { class: "said-text" }, event.text),
      );

/**
 * The audit trail of an agent's call, from its conversation: the request,
 * why the call was made, what the agent saw, and what it did next. Text is
 * the agent's own, quoted; the call is tied to the conversation by session,
 * tool and identical arguments.
 */
export function showAudit(entry, audit) {
  const host = document.getElementById("result-audit");
  if (!host) return;
  if (!audit) {
    host.replaceChildren(
      entry.source === "agent"
        ? h(
            "p",
            { class: "hint" },
            "No conversation is recorded for this call (only Claude Code sessions started from the workbench are captured).",
          )
        : null,
    );
    return;
  }
  host.replaceChildren(
    h(
      "section",
      { class: "audit" },
      h("h3", {}, "Audit trail"),
      h(
        "p",
        { class: "hint", title: `Tied by ${audit.matchedBy}.` },
        `${audit.agent ?? "Agent"}, turn ${audit.turn + 1}`,
      ),
      h("h4", {}, "Asked"),
      h("p", { class: "said-text" }, audit.request ?? "(no prompt)"),
      h("h4", {}, "Why this call"),
      audit.why.length
        ? h("ul", { class: "said-list" }, audit.why.map(said))
        : h("p", { class: "hint" }, "Nothing said before the call."),
      h("h4", {}, "What the agent saw"),
      audit.produced
        ? h("pre", { class: "said-result" }, audit.produced.text || "(empty)")
        : h("p", { class: "hint" }, "No result in the transcript yet."),
      h("h4", {}, "What came of it"),
      audit.outcome.length
        ? h("ul", { class: "said-list" }, audit.outcome.map(said))
        : h("p", { class: "hint" }, "Nothing yet after this call."),
    ),
  );
}

/** One conversation turn, in order, with rene calls linking to their entries. */
export function showTurn(turn, onCall) {
  const view = document.getElementById("result-view");
  const items = turn.events.map((event) => {
    if (event.kind === "tool_use")
      return h(
        "li",
        { class: "said action" },
        event.rea && event.historyId
          ? h(
              "button",
              {
                type: "button",
                class: "link",
                onclick: () => onCall(event.historyId),
              },
              `rene: ${event.tool}`,
            )
          : `${event.rea ? "rene: " : "Used "}${event.tool}${event.rea ? " (not recorded)" : ""}`,
      );
    if (event.kind === "tool_result")
      return h(
        "li",
        { class: "said result" },
        h(
          "details",
          {},
          h("summary", {}, event.isError ? "Result (error)" : "Result"),
          h("pre", { class: "said-result" }, event.text || "(empty)"),
        ),
      );
    return said(event);
  });
  view.replaceChildren(
    h(
      "section",
      { class: "audit turn" },
      h(
        "h3",
        {},
        `${turn.agent ?? "Agent"} conversation, turn ${turn.index + 1}`,
      ),
      h(
        "p",
        { class: "hint" },
        turn.at ? new Date(turn.at).toLocaleString() : "",
      ),
      h("h4", {}, "Asked"),
      h("p", { class: "said-text" }, turn.prompt ?? "(no prompt)"),
      h("ul", { class: "said-list" }, items),
    ),
  );
}

/** Replaces only the shown result's link line, keeping its tab and scroll. */
export function updateLinks(entry, onLink) {
  document.getElementById("result-links")?.replaceWith(linkLine(entry, onLink));
}

/** Renders one finished call into the result view. */
export function showEntry(entry, onEvidenceLink, onLink) {
  const resultView = document.getElementById("result-view");
  const actions = h("div", { class: "result-tools" });
  const line = h(
    "div",
    {},
    runLine(entry, actions),
    h("p", { class: "hint" }, `Run by ${sourceLabel(entry)}`),
    linkLine(entry, onLink),
    h("div", { id: "result-audit" }),
  );

  if (!entry.result) {
    resultView.replaceChildren(
      line,
      entry.resultOmitted
        ? h(
            "p",
            { class: "hint" },
            `This result was ${formatBytes(entry.resultBytes)}, more than history keeps for one call. Run the call again to see it.`,
          )
        : entry.cancelled
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

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
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
      // The agent owns its calls; only it can cancel them.
      entry.source === "agent"
        ? h("span", { class: "hint" }, `Run by ${sourceLabel(entry)}`)
        : h(
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

/** Time for today's calls; date and time for older ones. */
function startedLabel(startedAt) {
  const started = new Date(startedAt);
  return started.toDateString() === new Date().toDateString()
    ? started.toLocaleTimeString()
    : started.toLocaleString();
}

/** Renders call history; onSelect shows an entry, onCancel stops a live one. */
/** Turns whose calls are shown nested under them, by turn historyId. */
const expandedTurns = new Set();

/** Opens or folds every turn's nested calls at once. */
export function setTurnsExpanded(open, history) {
  expandedTurns.clear();
  if (open)
    for (const entry of history)
      if (entry.kind === "turn") expandedTurns.add(entry.historyId);
}

/**
 * Draws History. An agent's call that a turn links (the confirmed timestamp
 * link in conversations.mjs) is listed under that turn, folded until opened;
 * calls no turn links stay at the top level.
 */
export function renderHistory(history, { onSelect, onCancel, shown }) {
  const live = history.filter(isLive).length;
  document.getElementById("history-title").textContent = live
    ? `History, ${live} in progress`
    : "History";
  const byId = new Map(history.map((entry) => [entry.historyId, entry]));
  const nested = new Map();
  for (const entry of history)
    if (entry.kind === "turn")
      nested.set(
        entry,
        entry.turn.calls
          .map((call) => byId.get(call.historyId))
          .filter((call) => call !== undefined && call.kind !== "turn"),
      );
  const inTurn = new Set([...nested.values()].flat());
  for (const [turn, calls] of nested)
    if (calls.includes(shown)) expandedTurns.add(turn.historyId);
  const top = history.filter((entry) => !inTurn.has(entry));
  document.getElementById("history-empty").hidden = top.length > 0;
  const item = (entry) =>
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
        entry.kind === "turn"
          ? h(
              "span",
              { class: "h-name h-turn" },
              entry.turn.prompt
                ? `“${entry.turn.prompt.replace(/\s+/g, " ").slice(0, 80)}”`
                : "Conversation",
            )
          : h("span", { class: "h-name" }, entry.name),
        h(
          "span",
          { class: "h-meta" },
          h(
            "span",
            { class: "h-source", "data-source": entry.source ?? "workbench" },
            sourceLabel(entry),
          ),
          " · ",
          isLive(entry)
            ? liveStatus(entry)
            : [
                startedLabel(entry.startedAt),
                entry.elapsedMs === undefined
                  ? ""
                  : `, ${(entry.elapsedMs / 1000).toFixed(1)} s`,
              ],
        ),
        entry.kind === "turn" && entry.turn.calls.length
          ? h(
              "span",
              { class: "h-link" },
              `→ ${entry.turn.calls.length} rene call${entry.turn.calls.length === 1 ? "" : "s"}`,
            )
          : null,
        entry.links?.some((link) => link.from !== null)
          ? h(
              "span",
              { class: "h-link" },
              `← ${[...new Set(entry.links.filter((link) => link.from !== null).map((link) => link.tool))].join(", ")}`,
            )
          : null,
      ),
      isLive(entry) && entry.source !== "agent"
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
    );
  document.getElementById("history-list").replaceChildren(
    ...top.slice(0, 50).map((entry) => {
      const calls = nested.get(entry);
      const row = item(entry);
      if (!calls?.length) return row;
      const open = expandedTurns.has(entry.historyId);
      row.append(
        h(
          "button",
          {
            type: "button",
            class: "h-fold",
            "aria-expanded": String(open),
            onclick: () => {
              if (open) expandedTurns.delete(entry.historyId);
              else expandedTurns.add(entry.historyId);
              renderHistory(history, { onSelect, onCancel, shown });
            },
          },
          `${open ? "▾" : "▸"} ${calls.length} call${calls.length === 1 ? "" : "s"}`,
        ),
        open
          ? h(
              "ol",
              { class: "h-nested" },
              ...[...calls].sort((a, b) => a.startedAt - b.startedAt).map(item),
            )
          : null,
      );
      return row;
    }),
  );
}
