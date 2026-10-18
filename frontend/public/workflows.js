// Guided workflows: REA's MCP prompts. REA renders each brief from the
// caller's arguments; this module collects those arguments and lays out the
// returned messages, turning tool names in them into shortcuts.

import { apiJson } from "./api.js";
import { renderMarkdown } from "./markdown.js";
import { h, renderError } from "./render.js";

const COMPLETION_DELAY_MS = 200;

/** Renders the argument form for one prompt into the tool view. */
export function showWorkflowForm(prompt, { onStart }) {
  const view = document.getElementById("tool-view");
  document.getElementById("result-view").replaceChildren();
  const remembered = loadArgs(prompt.name) ?? {};
  const inputs = new Map();
  const fields = (prompt.arguments ?? []).map((argument) => {
    const field = argumentField(prompt.name, argument, inputs);
    field.input.value = remembered[argument.name] ?? "";
    inputs.set(argument.name, field.input);
    return field.element;
  });
  const formError = h("span", { class: "form-error", role: "alert" });
  const startButton = h(
    "button",
    { type: "submit", class: "primary" },
    "Start workflow",
  );

  const start = async () => {
    const args = collect(inputs);
    const missing = (prompt.arguments ?? []).filter(
      (argument) => argument.required && args[argument.name] === undefined,
    );
    if (missing.length) {
      formError.textContent = `Enter ${missing.map((argument) => argument.name).join(", ")}.`;
      return;
    }
    formError.textContent = "";
    startButton.disabled = true;
    startButton.textContent = "Starting…";
    try {
      const result = await apiJson("/api/prompts/get", {
        method: "POST",
        body: JSON.stringify({ name: prompt.name, arguments: args }),
      });
      saveArgs(prompt.name, args);
      onStart({ prompt, args, result, startedAt: Date.now() });
    } catch (cause) {
      formError.textContent = cause.message;
    } finally {
      startButton.disabled = false;
      startButton.textContent = "Start workflow";
    }
  };

  view.replaceChildren(
    h(
      "div",
      { class: "tool-head" },
      h("h2", {}, prompt.title ?? prompt.name),
      h("div", { class: "tool-name" }, prompt.name),
      h(
        "div",
        { class: "effects" },
        h("span", { class: "effect workflow" }, "workflow"),
      ),
    ),
    h("p", { class: "description" }, prompt.description ?? ""),
    h(
      "form",
      { onsubmit: (event) => (event.preventDefault(), void start()) },
      h("div", { class: "fields" }, fields),
      h("div", { class: "actions" }, startButton, formError),
    ),
  );
}

/** One string argument with server-side completion suggestions. */
function argumentField(promptName, argument, inputs) {
  const id = `prompt-${argument.name}`;
  const list = h("datalist", { id: `${id}-options` });
  const input = h("input", {
    id,
    list: list.id,
    spellcheck: "false",
    autocomplete: "off",
  });
  let timer;
  let sequence = 0;
  const suggest = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const request = ++sequence;
      const context = collect(inputs);
      delete context[argument.name];
      const response = await apiJson("/api/complete", {
        method: "POST",
        body: JSON.stringify({
          prompt: promptName,
          argument: { name: argument.name, value: input.value },
          context,
        }),
      }).catch(() => undefined);
      // Drop answers that a newer keystroke has superseded.
      if (request !== sequence || !response) return;
      list.replaceChildren(
        ...(response.completion?.values ?? []).map(
          (value) => new Option(value),
        ),
      );
    }, COMPLETION_DELAY_MS);
  };
  input.addEventListener("input", suggest);
  input.addEventListener("focus", suggest);

  return {
    input,
    element: h(
      "div",
      { class: "field" },
      h(
        "label",
        { for: id },
        argument.name,
        argument.required ? h("span", { class: "req" }, "required") : null,
      ),
      argument.description
        ? h("p", { class: "help" }, argument.description)
        : null,
      input,
      list,
    ),
  };
}

/** Prompt arguments are strings; an empty field omits the argument. */
function collect(inputs) {
  const args = {};
  for (const [name, input] of inputs) {
    if (input.value !== "") args[name] = input.value;
  }
  return args;
}

/**
 * Renders the active workflow brief, which stays visible while tools run.
 * @param {{ prompt, args, result, startedAt } | undefined} workflow
 * @param {{ toolNames: Set<string>, outcomes: Map<string, string>, onTool(name: string): void, onClose(): void }} options
 */
export function renderWorkflowPanel(
  workflow,
  { toolNames, outcomes, onTool, onClose },
) {
  const panel = document.getElementById("workflow-panel");
  if (!workflow) {
    panel.replaceChildren();
    panel.hidden = true;
    return;
  }
  const wasOpen = panel.querySelector("details")?.open ?? true;
  const messages = workflow.result.messages ?? [];
  const renderCode = (code) => {
    if (!toolNames.has(code)) return null;
    const outcome = outcomes.get(code);
    return h(
      "button",
      {
        type: "button",
        class: "tool-chip",
        "data-outcome": outcome,
        title:
          outcome === "ok"
            ? "Ran successfully in this workflow. Open it again."
            : outcome === "error"
              ? "Failed in this workflow. Open it to retry."
              : "Open this tool",
        onclick: () => onTool(code),
      },
      code,
    );
  };
  const body = messages.map((message) =>
    h(
      "div",
      { class: "wf-message" },
      messages.length > 1 ? h("div", { class: "wf-role" }, message.role) : null,
      message.content?.type === "text"
        ? renderMarkdown(message.content.text, renderCode)
        : renderError(
            undefined,
            `Unsupported ${message.content?.type} content.`,
          ),
    ),
  );
  const argSummary = Object.entries(workflow.args)
    .map(([name, value]) => `${name}: ${value}`)
    .join(", ");
  const copyButton = h(
    "button",
    {
      type: "button",
      class: "quiet",
      onclick: async () => {
        await navigator.clipboard?.writeText(briefText(messages));
        copyButton.textContent = "Copied";
        setTimeout(
          () => (copyButton.textContent = "Copy as agent prompt"),
          1500,
        );
      },
    },
    "Copy as agent prompt",
  );

  panel.hidden = false;
  panel.replaceChildren(
    h(
      "details",
      { class: "workflow", open: wasOpen },
      h(
        "summary",
        {},
        h(
          "span",
          { class: "wf-title" },
          workflow.prompt.title ?? workflow.prompt.name,
        ),
        argSummary ? h("span", { class: "wf-args" }, argSummary) : null,
      ),
      h("div", { class: "wf-body" }, body),
      h(
        "div",
        { class: "wf-actions" },
        copyButton,
        h(
          "button",
          { type: "button", class: "quiet", onclick: onClose },
          "Close workflow",
        ),
      ),
    ),
  );
}

function briefText(messages) {
  return messages
    .map((message) =>
      message.content?.type === "text"
        ? message.content.text
        : JSON.stringify(message.content),
    )
    .join("\n\n");
}

function loadArgs(name) {
  try {
    const stored = localStorage.getItem(`rea-prompt-args:${name}`);
    return stored ? JSON.parse(stored) : undefined;
  } catch {
    return undefined;
  }
}

function saveArgs(name, args) {
  try {
    localStorage.setItem(`rea-prompt-args:${name}`, JSON.stringify(args));
  } catch {
    // Remembered arguments are a convenience only.
  }
}
