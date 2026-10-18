import { h } from "./render.js";

// Tool families for the catalog. First match wins; order is significant.
export const GROUPS = [
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

/** Filters tools and groups them by family, preserving GROUPS order. */
export function groupTools(tools, filter) {
  const matches = tools.filter(
    (tool) =>
      !filter ||
      tool.name.includes(filter) ||
      (tool.title ?? "").toLowerCase().includes(filter) ||
      (tool.description ?? "").toLowerCase().includes(filter),
  );
  const grouped = new Map(GROUPS.map(([label]) => [label, []]));
  for (const tool of matches) {
    const [label] = GROUPS.find(([, pattern]) => pattern.test(tool.name));
    grouped.get(label).push(tool);
  }
  for (const group of grouped.values()) {
    group.sort((a, b) => a.name.localeCompare(b.name));
  }
  return [...grouped].filter(([, group]) => group.length > 0);
}
