// The Agent Terminal's usage bar: what the running session's agent has used
// (tokens, time), how much of it was wasted and on what, signs of wrong
// assumptions, and how far its current task has got with an estimate of the
// time left. The bridge works it out (frontend/usage.mjs); this only shows it.

import { apiJson } from "./api.js";
import { h } from "./render.js";

const REFRESH_MS = 5000;

const tokens = (count) =>
  count >= 1e6
    ? `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`
    : count >= 1e3
      ? `${(count / 1e3).toFixed(count >= 1e4 ? 0 : 1)}k`
      : String(count);

const duration = (ms) => {
  if (ms === null || ms === undefined) return "–";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
};

const percent = (part, whole) =>
  whole > 0 ? `${Math.round((100 * part) / whole)}%` : "–";

const stat = (label, value, detail) =>
  h(
    "div",
    { class: "usage-stat" },
    h("span", { class: "usage-label" }, label),
    h("span", { class: "usage-value" }, value),
    detail ? h("span", { class: "usage-detail" }, detail) : undefined,
  );

/** Where the session's time went: productive work, waste, waiting on you. */
function timeBar(time) {
  const productive = Math.max(0, time.working - time.wasted);
  const parts = [
    ["productive", "Working", productive],
    ["wasted", "Wasted", time.wasted],
    ["tools", "Waiting on commands", time.waitingOnTools ?? 0],
    ["waiting", "Waiting on you", time.waitingOnYou],
  ];
  const total = parts.reduce((sum, [, , ms]) => sum + ms, 0);
  return h(
    "div",
    { class: "usage-time" },
    h(
      "div",
      {
        class: "usage-bar",
        role: "img",
        "aria-label": parts
          .map(([, label, ms]) => `${label} ${duration(ms)}`)
          .join(", "),
      },
      ...parts.map(([kind, label, ms]) => {
        const segment = h("span", {
          class: `usage-seg usage-${kind}`,
          title: `${label}: ${duration(ms)}`,
        });
        // Through the DOM, which the page's style policy allows.
        segment.style.flexGrow = String(total ? ms / total : 0);
        return segment;
      }),
    ),
    h(
      "div",
      { class: "usage-legend" },
      ...parts.map(([kind, label, ms]) =>
        h(
          "span",
          {},
          h("i", { class: `usage-swatch usage-${kind}` }),
          `${label} ${duration(ms)}`,
        ),
      ),
    ),
  );
}

/** The current task, its time and an honest estimate of the time left. */
function task(progress) {
  const current = progress.topics.find(
    (topic) => topic.id === progress.current,
  );
  if (!current)
    return h(
      "p",
      { class: "usage-task hint" },
      progress.topics.length
        ? "No open task: every topic declared this session is closed."
        : "No task declared yet: progress shows once the agent declares a topic.",
    );
  const estimate = progress.estimate;
  const spent = [
    `${duration(current.elapsed)} so far`,
    current.working !== null
      ? `${duration(current.working)} working`
      : undefined,
    current.wasted ? `${duration(current.wasted)} wasted` : undefined,
  ].filter(Boolean);
  const left =
    estimate?.median !== null && estimate?.median !== undefined
      ? `About ${duration(estimate.median)} left, up to ${duration(estimate.p80)}: from the ${estimate.ranThisLong} of ${estimate.finished} finished topics here that ran this long.`
      : `No honest estimate of time left. ${estimate?.reason ?? ""}`;
  return h(
    "div",
    { class: "usage-task" },
    h(
      "div",
      {},
      h("span", { class: "usage-label" }, "Current task "),
      h("strong", {}, current.title),
      h(
        "span",
        { class: "usage-detail" },
        ` · ${current.status} · ${spent.join(" · ")}`,
      ),
    ),
    h("div", { class: "usage-detail" }, left),
    estimateLine(current),
    ...current.phases.map((phase) =>
      h(
        "div",
        { class: "usage-phase" },
        h("span", { class: "usage-label" }, `Phase ${phase.name} `),
        h(
          "span",
          { class: "usage-detail" },
          `${duration(phase.working)} working · ${count(phase.actual.model_calls)} calls · ${tokens(phase.actual.output_tokens)} out`,
        ),
        phase.accuracy ? estimateLine({ accuracy: phase.accuracy }) : undefined,
      ),
    ),
    deviationLine(current.deviation),
  );
}

const CAUSE_LABELS = {
  assumption: "assumption",
  you: "you",
  agent: "agent",
  instructions: "instructions",
  blocked: "blocked",
};

/** How the task deviated, by cause, and from its plan. */
function deviationLine(deviation) {
  if (!deviation) return undefined;
  const causes = Object.entries(deviation.byCause).map(
    ([cause, times]) => `${CAUSE_LABELS[cause] ?? cause} ${times}`,
  );
  const plan = [
    deviation.unplanned.length
      ? `unplanned: ${deviation.unplanned.map((phase) => `${phase.name} (${phase.cause})`).join(", ")}`
      : undefined,
    deviation.skipped.length
      ? `skipped: ${deviation.skipped.join(", ")}`
      : undefined,
    deviation.plan ? undefined : "no plan given",
  ].filter(Boolean);
  if (!causes.length && !plan.length) return undefined;
  return h(
    "div",
    {
      class: "usage-detail usage-deviation",
      title: deviation.latest
        .map((entry) => `${entry.cause} · ${entry.kind}: ${entry.text}`)
        .join("\n"),
    },
    h("span", { class: "usage-label" }, "Deviation "),
    [...causes, ...plan].join(" · "),
  );
}

const MEASURE_LABELS = {
  model_calls: ["Model calls", (value) => count(value)],
  output_tokens: ["Output", (value) => tokens(value)],
  context_tokens: ["Context read", (value) => tokens(value)],
  working_minutes: ["Working", (value) => `${value}m`],
};

/**
 * The agent's up-front estimate against what the task used, across all its
 * conversations: so far while it is open, and whether it landed once closed.
 */
function estimateLine(topic) {
  const accuracy = topic.accuracy;
  if (!accuracy)
    return h(
      "div",
      { class: "usage-detail" },
      "No estimate was given when this task was declared.",
    );
  const parts = accuracy.measures.map((measure) => {
    const [label, format] = MEASURE_LABELS[measure.measure];
    const verdict = accuracy.closed
      ? measure.within
        ? " ✓"
        : measure.over
          ? " over"
          : " under"
      : measure.over
        ? " over"
        : "";
    return h(
      "span",
      { class: measure.over ? "usage-over" : "" },
      `${label} ${format(measure.actual)} of ${format(measure.low)}–${format(measure.high)}${verdict}`,
    );
  });
  return h(
    "div",
    {
      class: "usage-detail usage-estimate",
      title: accuracy.basis ? `Basis: ${accuracy.basis}` : "",
    },
    h(
      "span",
      { class: "usage-label" },
      `Estimate (${accuracy.confidence})${topic.reestimated ? ", re-estimated since" : ""} `,
    ),
    ...parts.flatMap((part, index) => (index ? [" · ", part] : [part])),
  );
}

const examples = (list) =>
  h(
    "ul",
    { class: "usage-examples" },
    ...list.map((entry) =>
      h(
        "li",
        {},
        h(
          "time",
          { datetime: entry.at },
          new Date(entry.at).toLocaleTimeString(),
        ),
        " ",
        entry.text,
      ),
    ),
  );

/** What the waste, signals and topics rest on, for checking. */
function breakdown(usage) {
  const { waste, signals, progress, method, tokens: used } = usage;
  return h(
    "details",
    { class: "usage-more" },
    h("summary", {}, "Waste, signals and tasks"),
    h("h3", {}, "Wasted"),
    waste.reasons.length
      ? h(
          "table",
          { class: "usage-table" },
          h(
            "thead",
            {},
            h(
              "tr",
              {},
              ...[
                "",
                "Times",
                "Time",
                "Output tokens",
                "Context tokens (est.)",
                "Latest",
              ].map((text) => h("th", {}, text)),
            ),
          ),
          h(
            "tbody",
            {},
            ...waste.reasons.map((entry) =>
              h(
                "tr",
                {},
                h("th", { scope: "row" }, entry.label),
                h("td", {}, String(entry.count)),
                h("td", {}, duration(entry.ms)),
                h("td", {}, tokens(entry.outputTokens)),
                h("td", {}, tokens(entry.contextTokens)),
                h("td", {}, examples(entry.examples.slice(-1))),
              ),
            ),
          ),
        )
      : h("p", { class: "hint" }, "Nothing wasted so far."),
    h("h3", {}, "Signs of wrong assumptions"),
    signals.length
      ? h(
          "ul",
          { class: "usage-signals" },
          ...signals.map((entry) =>
            h(
              "li",
              {},
              h("strong", {}, `${entry.label} · ${entry.count}`),
              examples(entry.examples),
            ),
          ),
        )
      : h("p", { class: "hint" }, "None so far."),
    h("h3", {}, "Conversations"),
    h(
      "ul",
      { class: "usage-topics" },
      ...usage.conversations.map((conversation) =>
        h(
          "li",
          { title: conversation.session },
          `${conversation.agent} ${conversation.session.slice(0, 8)} · ${tokens(conversation.total)} tokens · ${count(conversation.calls)} calls · ${tokens(conversation.output)} out`,
        ),
      ),
    ),
    h("h3", {}, "Tasks this session"),
    progress.topics.length
      ? h(
          "ul",
          { class: "usage-topics" },
          ...progress.topics.map((topic) =>
            h(
              "li",
              {},
              h(
                "span",
                { class: `usage-status usage-status-${topic.status}` },
                topic.status,
              ),
              ` ${topic.title} · ${duration(topic.elapsed)}`,
              topic.wasted ? ` · ${duration(topic.wasted)} wasted` : "",
              topic.accuracy ? estimateLine(topic) : undefined,
            ),
          ),
        )
      : h("p", { class: "hint" }, "None declared yet."),
    used.byModel.length > 1
      ? h(
          "p",
          { class: "hint" },
          `By model: ${used.byModel.map((model) => `${model.model} ${tokens(model.output)} out`).join(", ")}.`,
        )
      : undefined,
    h("h3", {}, "How it's measured"),
    h(
      "ul",
      { class: "usage-method" },
      ...[...Object.values(method), usage.account?.method]
        .filter(Boolean)
        .map((text) => h("li", {}, text)),
    ),
  );
}

const clock = (ms) =>
  new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const when = (ms) => {
  const date = new Date(ms);
  return date.toDateString() === new Date().toDateString()
    ? clock(ms)
    : date.toLocaleString([], {
        weekday: "short",
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
};
const count = (value) => Math.round(value).toLocaleString();
const WINDOW_LABELS = { session: "Session window", weekly: "Weekly" };

/** A plan meter: used as reported, and the estimate since, lighter. */
function meter(percent, estimate) {
  const bar = h("span", {
    class: "usage-meter",
    role: "img",
    "aria-label": `${Math.round(percent)}% used`,
  });
  const used = h("span", { class: "usage-meter-used" });
  used.style.width = `${Math.min(100, percent)}%`;
  bar.append(used);
  if (estimate !== null && estimate > percent) {
    const since = h("span", { class: "usage-meter-since" });
    since.style.width = `${Math.min(100, estimate) - Math.min(100, percent)}%`;
    bar.append(since);
  }
  return bar;
}

const tokensOf = (totals) =>
  totals.input + totals.cacheRead + totals.cacheWrite + totals.output;
const periods = (local, unit) =>
  ["today", "week", "month"]
    .map(
      (period) =>
        `${{ today: "today", week: "this week", month: "this month" }[period]} ${unit(local[period])}`,
    )
    .join(" · ");

function planRow(window) {
  const label = WINDOW_LABELS[window.group] ?? window.kind;
  if (window.rolledOver)
    return h(
      "div",
      { class: "usage-plan-row" },
      h("span", { class: "usage-label" }, label),
      h(
        "span",
        { class: "usage-detail" },
        "Reset since Claude Code last fetched it: no current figure yet.",
      ),
    );
  // An estimate only says something when use since the figure moved it.
  const estimate =
    window.estimate && window.estimate.percent - window.percent >= 1
      ? window.estimate
      : null;
  const parts = [
    `${Math.round(window.percent)}% used, ${Math.round(window.left)}% left`,
    estimate ? `estimated ${Math.round(estimate.percent)}% now` : undefined,
    window.resetsAt
      ? `resets ${when(window.resetsAt)} (in ${duration(window.resetsAt - Date.now())})`
      : undefined,
    estimate?.fullAt
      ? `at this pace full by ${when(estimate.fullAt)}`
      : undefined,
  ].filter(Boolean);
  const near = (estimate?.percent ?? window.percent) >= NEAR_LIMIT;
  return h(
    "div",
    {
      class: `usage-plan-row${window.active ? " usage-plan-active" : ""}${near ? " usage-plan-near" : ""}`,
    },
    h("span", { class: "usage-label" }, label),
    meter(window.percent, estimate?.percent ?? null),
    h("span", { class: "usage-detail" }, parts.join(" · ")),
  );
}

// A plan window this full is worth a reset, or a pause.
const NEAR_LIMIT = 80;

/**
 * Limit resets: the grants when Claude Code cached them, and a way to ask
 * Claude Code itself (its /limit-reset lists them and asks before using one).
 */
function resetsRow(plan, session) {
  const resets = plan?.resets;
  const near = (plan?.windows ?? []).some(
    (window) =>
      !window.rolledOver &&
      (window.estimate?.percent ?? window.percent) >= NEAR_LIMIT,
  );
  const text =
    resets === null || resets === undefined
      ? "Not known: Claude Code checks only at a limit or for /limit-reset."
      : resets.length === 0
        ? "None right now."
        : resets
            .map(
              (grant) =>
                `${grant.label}: ${grant.left}${grant.total !== null ? ` of ${grant.total}` : ""} left${grant.ends_at ? `, until ${when(Date.parse(grant.ends_at))}` : ""}${grant.paused ? " (paused)" : grant.usable_now ? "" : " (not usable yet)"}`,
            )
            .join(" · ");
  const usable = resets?.some((grant) => grant.left > 0 && grant.usable_now);
  const canAsk = session?.agent === "Claude Code" && session.running === true;
  const row = h(
    "div",
    {
      class: `usage-plan-row${near && (usable || resets == null) ? " usage-plan-near" : ""}`,
    },
    h("span", { class: "usage-label" }, "Limit resets"),
    h("span", { class: "usage-detail" }, text),
  );
  if (canAsk) row.append(resetButton(session));
  return row;
}

/** Types /limit-reset into Claude Code, after a second click to confirm. */
function resetButton(session) {
  const button = h(
    "button",
    { type: "button", class: "link usage-reset" },
    "Use a limit reset…",
  );
  // Typed mid-turn it would reach the agent as a message, not a command.
  if (session.turnRunning) {
    button.disabled = true;
    button.title =
      "Claude Code is working: this is offered when its turn ends.";
    return button;
  }
  let armed = false;
  button.addEventListener("click", async () => {
    if (!armed) {
      armed = true;
      button.textContent =
        "Type /limit-reset into Claude Code? It lists your resets and asks before using one. Click again";
      setTimeout(() => {
        armed = false;
        button.textContent = "Use a limit reset…";
      }, 8000);
      return;
    }
    armed = false;
    button.disabled = true;
    try {
      await apiJson("/api/terminal/limit-reset", { method: "POST" });
      button.textContent = "Sent: answer Claude Code's menu in the terminal.";
    } catch (cause) {
      button.textContent = cause.message;
    }
  });
  return button;
}

/** The accounts: plan limits and what is left, and this machine's use. */
function account(summary, session) {
  if (!summary) return undefined;
  const { claude, copilot } = summary;
  const sections = [];
  if (claude.plan || tokensOf(claude.local.month) > 0) {
    const plan = claude.plan;
    const extra = plan?.extraUsage;
    sections.push(
      h(
        "div",
        { class: "usage-plan" },
        h("strong", {}, "Claude Code plan"),
        plan
          ? h(
              "span",
              { class: "usage-detail" },
              plan.live
                ? ` · live from Claude Code, as of ${when(plan.fetchedAt)}`
                : ` · Claude Code's last fetch, as of ${when(plan.fetchedAt)}`,
            )
          : h(
              "span",
              { class: "usage-detail" },
              " · no plan figures cached yet",
            ),
        ...(plan?.windows ?? []).map(planRow),
        plan ? resetsRow(plan, session) : undefined,
        extra
          ? h(
              "div",
              { class: "usage-plan-row" },
              h("span", { class: "usage-label" }, "Extra usage"),
              h(
                "span",
                { class: "usage-detail" },
                `${extra.currency ?? ""} ${extra.used.toFixed(2)} of ${extra.limit === null ? "no limit" : extra.limit.toFixed(2)} this month · ${extra.enabled ? "on" : `off${extra.disabled_reason ? ` (${extra.disabled_reason.replaceAll("_", " ")})` : ""}`}`,
              ),
            )
          : undefined,
        h(
          "div",
          { class: "usage-plan-row" },
          h("span", { class: "usage-label" }, "This machine"),
          h(
            "span",
            { class: "usage-detail" },
            `${periods(claude.local, (totals) => `${tokens(tokensOf(totals))} tokens`)}${plan?.claudeCodeShare !== null && plan?.claudeCodeShare !== undefined ? ` · Claude Code is ${plan.claudeCodeShare}% of the week's use` : ""}`,
          ),
        ),
      ),
    );
  }
  if (copilot.quota || copilot.local.month.premiumRequests > 0) {
    const quota = copilot.quota;
    sections.push(
      h(
        "div",
        { class: "usage-plan" },
        h("strong", {}, "Copilot CLI plan"),
        quota?.at
          ? h("span", { class: "usage-detail" }, ` · as of ${when(quota.at)}`)
          : undefined,
        quota
          ? h(
              "div",
              { class: "usage-plan-row" },
              h("span", { class: "usage-label" }, "Premium requests"),
              quota.unlimited
                ? undefined
                : meter(100 - (quota.remainingPercent ?? 100), null),
              h(
                "span",
                { class: "usage-detail" },
                quota.unlimited
                  ? "Unlimited"
                  : `${count(quota.used)} of ${count(quota.entitlement ?? 0)} used, ${quota.remainingPercent ?? "–"}% left${quota.resetsAt ? ` · resets ${when(quota.resetsAt)}` : ""}${quota.overageAllowed ? " · overage allowed" : ""}`,
              ),
            )
          : undefined,
        h(
          "div",
          { class: "usage-plan-row" },
          h("span", { class: "usage-label" }, "This machine"),
          h(
            "span",
            { class: "usage-detail" },
            periods(
              copilot.local,
              (totals) => `${count(totals.premiumRequests)} premium requests`,
            ),
          ),
        ),
      ),
    );
  }
  return sections.length
    ? h("div", { class: "usage-account", title: summary.method }, ...sections)
    : undefined;
}

function render(usage) {
  if (!usage?.available)
    return [
      account(usage?.account, null),
      h(
        "p",
        { class: "hint" },
        "Session usage shows here while an agent runs.",
      ),
    ].filter(Boolean);
  const { tokens: used, time, waste } = usage;
  return [
    account(usage.account, {
      agent: usage.agent,
      running: usage.agentRunning,
      turnRunning: usage.running,
    }),
    h(
      "div",
      { class: "usage-stats" },
      stat(
        "Tokens",
        tokens(used.total),
        `${tokens(used.input)} in · ${tokens(used.cacheRead)} cached · ${tokens(used.cacheWrite)} cache written · ${tokens(used.output)} out`,
      ),
      stat(
        "Calls",
        String(used.calls),
        [
          used.context !== null
            ? used.contextLimit
              ? `context ${tokens(used.context)} of ${tokens(used.contextLimit)} (${Math.round((used.context / used.contextLimit) * 100)}%)`
              : `context ${tokens(used.context)}`
            : undefined,
          used.compactions ? `${used.compactions} compacted` : undefined,
          used.premiumRequests !== null
            ? `${used.premiumRequests} premium requests`
            : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      ),
      ...(used.aiCredits === null
        ? []
        : [
            stat(
              "Credits",
              used.aiCredits.toFixed(2),
              "AI credits its service billed",
            ),
          ]),
      stat(
        usage.running ? "Time, running" : "Time",
        duration(time.elapsed),
        `${usage.turns} turn${usage.turns === 1 ? "" : "s"} · ${duration(time.working)} working`,
      ),
      stat(
        "Wasted",
        `${duration(time.wasted)} · ${percent(time.wasted, time.working)}`,
        `of working time · ${tokens(waste.outputTokens)} output tokens (${waste.outputShare === null ? "–" : percent(waste.outputTokens, used.output)})`,
      ),
      stat(
        "Wrong assumptions",
        String(usage.signals.reduce((sum, entry) => sum + entry.count, 0)),
        "signs, see below",
      ),
    ),
    timeBar(time),
    task(usage.progress),
    breakdown(usage),
  ];
}

const HIDDEN_KEY = "rea-usage-hidden";
const hiddenSaved = () => {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
};
const saveHidden = (hidden) => {
  try {
    localStorage.setItem(HIDDEN_KEY, hidden ? "1" : "0");
  } catch {
    // Not kept in this browser; the bar still hides for now.
  }
};

/** The hidden bar's one line: the plan window that limits use now, and the session's time. */
function summaryLine(usage) {
  const windows = usage?.account?.claude.plan?.windows ?? [];
  const limiting = windows.find((window) => window.active) ?? windows[0];
  const parts = [];
  if (limiting && !limiting.rolledOver)
    parts.push(
      `${WINDOW_LABELS[limiting.group] ?? limiting.kind} ${Math.round(limiting.estimate?.percent ?? limiting.percent)}% used${limiting.resetsAt ? `, resets ${when(limiting.resetsAt)}` : ""}`,
    );
  if (usage?.available)
    parts.push(
      `${tokens(usage.tokens.total)} tokens`,
      `${duration(usage.time.working)} working, ${duration(usage.time.wasted)} wasted`,
    );
  return parts.join(" · ") || "Usage";
}

/**
 * The usage bar. refresh() reads the usage again; it also refreshes itself
 * while it is on screen and the agent runs. It can be hidden to one line,
 * remembered in this browser.
 */
export function usageBar() {
  const element = h("section", {
    class: "usage",
    "aria-label": "Session usage",
    "aria-live": "off",
  });
  let running = false;
  let timer;
  let open = false;
  let hidden = hiddenSaved();
  let last;
  const toggle = h("button", { type: "button", class: "link usage-toggle" });
  const line = h("span", { class: "usage-detail usage-line" });
  const body = h("div", { class: "usage-body" });
  const show = () => {
    toggle.textContent = hidden ? "Show usage" : "Hide usage";
    toggle.setAttribute("aria-expanded", String(!hidden));
    body.hidden = hidden;
    line.textContent = hidden ? summaryLine(last) : "";
  };
  toggle.addEventListener("click", () => {
    hidden = !hidden;
    saveHidden(hidden);
    show();
  });
  element.append(h("div", { class: "usage-head" }, line, toggle), body);
  const refresh = async () => {
    try {
      const usage = await apiJson("/api/terminal/usage");
      last = usage;
      // Keep the breakdown open across refreshes.
      open = body.querySelector("details")?.open ?? open;
      body.replaceChildren(...render(usage));
      const details = body.querySelector("details");
      if (details) details.open = open;
      show();
    } catch {
      // The bridge restarted; the next refresh tries again.
    }
  };
  const tick = () => {
    clearTimeout(timer);
    if (!running) return;
    timer = setTimeout(async () => {
      if (element.isConnected) await refresh();
      tick();
    }, REFRESH_MS);
  };
  body.replaceChildren(...render(undefined));
  show();
  return {
    element,
    refresh,
    /** Follows the session's state: refreshes on each change, and while it runs. */
    stateChanged(state) {
      running = Boolean(state.running);
      void refresh();
      tick();
    },
  };
}
