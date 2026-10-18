import { h } from "./render.js";

// Tool families for the catalog. First match wins; order is significant.
const GROUPS = [
  [
    "Sessions & Evidence",
    /^(open_binary|close_binary|binary_session|inspect_analysis_view|get_navigation_context|inspect_address_context)$|evidence|unknown/,
  ],
  ["ADB devices", /adb/],
  ["Android", /android|apktool|jeb/],
  ["Managed (.NET)", /managed/],
  ["Debuggers & instrumentation", /frida|gdb|rizin|cutter/],
  ["Web & browser", /web|browser/],
  ["JavaScript & Electron", /javascript|electron|bundle/],
  [
    "Captures & signals",
    /pcap|packet|signal|process_scenario|process_captures/,
  ],
  [
    "Comparison & reconstruction",
    /compare|reconstruction|changed_behavior|build_call_path|correlate|application_graph|application_feature/,
  ],
  [
    "Artifacts & formats",
    /artifact|firmware|wasm|evm|sqlite|duckdb|flutter|dart|plist|keyed_archive|asset_catalog|interface_builder|pe_resources/,
  ],
  [
    "Native analysis",
    /native|macho|signature|architectures|swift|objc|dylib|binary_layout|go_binary|rust_binary|crash|objdump|trace_feature|trace_call_path/,
  ],
  ["Binary navigation & annotation", /.*/],
];

/** Effect badge from the tool's MCP annotations. */
export function effectBadge(annotations) {
  if (annotations?.destructiveHint)
    return h(
      "span",
      {
        class: "effect destructive",
        title: "May change or remove external state",
      },
      "changes",
    );
  if (annotations?.readOnlyHint)
    return h("span", { class: "effect readonly", title: "Read-only" }, "read");
  if (annotations?.openWorldHint)
    return h(
      "span",
      {
        class: "effect external",
        title: "Touches external processes, devices, or the network",
      },
      "live",
    );
  return null;
}

const WORKFLOWS = "Guided workflows";

/** Case-insensitive match on name, title, or description. */
function matches(item, filter) {
  return (
    !filter ||
    item.name.includes(filter) ||
    (item.title ?? "").toLowerCase().includes(filter) ||
    (item.description ?? "").toLowerCase().includes(filter)
  );
}

/** Filters tools and groups them by family, preserving GROUPS order. */
function groupTools(tools, filter) {
  const matching = tools.filter((tool) => matches(tool, filter));
  const grouped = new Map(GROUPS.map(([label]) => [label, []]));
  for (const tool of matching) {
    const [label] = GROUPS.find(([, pattern]) => pattern.test(tool.name));
    grouped.get(label).push(tool);
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...grouped].filter(([, group]) => group.length > 0);
}

/**
 * Renders the sidebar: guided workflows (MCP prompts) first, then tool families.
 * `selected` is { kind: "tool" | "prompt", name }.
 */
export function renderCatalog({
  tools,
  prompts,
  filter,
  selected,
  onTool,
  onPrompt,
}) {
  const isSelected = (kind, name) =>
    selected?.kind === kind && selected.name === name;
  const workflowItems = prompts
    .filter((prompt) => matches(prompt, filter))
    .map((prompt) =>
      h(
        "button",
        {
          type: "button",
          class: "tool-item workflow-item",
          "aria-current": String(isSelected("prompt", prompt.name)),
          title: prompt.description ?? prompt.name,
          onclick: () => onPrompt(prompt.name),
        },
        h("span", { class: "name" }, prompt.title ?? prompt.name),
      ),
    );
  const toolGroups = groupTools(tools, filter).map(([label, members]) => [
    label,
    members.map((tool) =>
      h(
        "button",
        {
          type: "button",
          class: "tool-item",
          "aria-current": String(isSelected("tool", tool.name)),
          title: tool.title ?? tool.name,
          onclick: () => onTool(tool.name),
        },
        h("span", { class: "name" }, tool.name),
        effectBadge(tool.annotations),
      ),
    ),
  ]);
  const groups = [
    ...(workflowItems.length ? [[WORKFLOWS, workflowItems]] : []),
    ...toolGroups,
  ];
  const container = document.getElementById("tool-groups");
  if (groups.length === 0) {
    container.replaceChildren(
      h("p", { class: "hint catalog-empty" }, `Nothing matches “${filter}”.`),
    );
    return;
  }
  container.replaceChildren(
    ...groups.map(([label, items]) =>
      h(
        "details",
        {
          open:
            Boolean(filter) ||
            label === WORKFLOWS ||
            label === GROUPS[0][0] ||
            items.some((item) => item.getAttribute("aria-current") === "true"),
        },
        h("summary", {}, label, h("span", { class: "count" }, items.length)),
        h(
          "ul",
          {},
          items.map((item) => h("li", {}, item)),
        ),
      ),
    ),
  );
}
