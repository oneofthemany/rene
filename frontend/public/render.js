// Renders MCP tool results. REA owns the meaning of every field; this module
// only lays out what the result already states.

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/;
const TREE_PAGE = 200;
const LEVELS = ["observed", "derived", "inferred"];

/** Builds a DOM element with optional class and children. */
export function h(tag, attributes = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    if (key === "class") element.className = value;
    else if (key.startsWith("on"))
      element.addEventListener(key.slice(2), value);
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    element.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return element;
}

/** Returns the structured payload, decoding a JSON text block when that is all REA sent. */
export function payloadOf(result) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const texts = (result.content ?? []).filter((block) => block.type === "text");
  if (texts.length !== 1) return undefined;
  try {
    return JSON.parse(texts[0].text);
  } catch {
    return undefined;
  }
}

export function isEvidence(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.evidence_id === "string" &&
    LEVELS.includes(value.confidence)
  );
}

/** Error card for REA's tagged error payloads, or plain text for protocol errors. */
export function renderError(payload, fallbackText) {
  const error = payload?.error;
  if (typeof error !== "object" || error === null) {
    return h(
      "div",
      { class: "error-card" },
      h("h3", {}, "The call failed"),
      h("p", {}, fallbackText ?? "No error details were returned."),
    );
  }
  const remediation = error.remediation?.action;
  return h(
    "div",
    { class: "error-card" },
    h("h3", {}, error.message ?? "The call failed"),
    h(
      "div",
      { class: "code" },
      [error.code, error.category].filter(Boolean).join(" / "),
      error.retryable ? " (retryable)" : "",
    ),
    remediation && remediation !== error.message
      ? h("p", {}, remediation)
      : null,
  );
}

/** Provenance summary for one Evidence record. */
export function renderProvenance(evidence, onEvidenceLink) {
  const rows = [];
  const add = (label, value) => {
    if (
      value === undefined ||
      value === null ||
      (Array.isArray(value) && value.length === 0)
    )
      return;
    rows.push(h("dt", {}, label), h("dd", {}, value));
  };
  const subject = evidence.subject;
  add(
    "Subject",
    subject
      ? [
          h(
            "span",
            { class: "mono" },
            subject.local_path ?? subject.name ?? "",
          ),
          subject.digest?.sha256
            ? h(
                "div",
                { class: "mono meta" },
                `sha256 ${subject.digest.sha256}`,
              )
            : null,
        ]
      : null,
  );
  add(
    "Provider",
    evidence.provider
      ? `${evidence.provider.name ?? evidence.provider.id}${evidence.provider.version ? ` ${evidence.provider.version}` : ""}`
      : null,
  );
  add("Operation", h("span", { class: "mono" }, evidence.operation));
  add("Authority", evidence.authority);
  add("Evidence", evidenceLink(evidence.evidence_id, onEvidenceLink));
  add(
    "Links",
    (evidence.evidence_links ?? []).map((id) =>
      h("div", {}, evidenceLink(id, onEvidenceLink)),
    ),
  );
  add("Locations", locationList(evidence.locations));
  add(
    "Limitations",
    evidence.limitations?.length
      ? h(
          "ul",
          { class: "limitations" },
          evidence.limitations.map((text) => h("li", {}, text)),
        )
      : null,
  );

  return h(
    "section",
    { class: "provenance", "aria-label": "Evidence provenance" },
    h(
      "div",
      {
        class: "scale",
        role: "img",
        "aria-label": `Confidence: ${evidence.confidence}`,
      },
      LEVELS.map((level) =>
        h(
          "span",
          {
            "data-level": level,
            "data-on": String(level === evidence.confidence),
          },
          level,
        ),
      ),
    ),
    h("dl", { class: "prov-rows" }, rows),
  );
}

function locationList(locations) {
  if (!Array.isArray(locations) || locations.length === 0) return null;
  const shown = locations
    .slice(0, 8)
    .map((location) =>
      h(
        "div",
        { class: "mono" },
        location.path ??
          location.address ??
          location.url ??
          JSON.stringify(location),
      ),
    );
  if (locations.length > 8)
    shown.push(
      h(
        "div",
        { class: "meta" },
        `and ${locations.length - 8} more in the structured result`,
      ),
    );
  return shown;
}

function evidenceLink(id, onEvidenceLink) {
  if (typeof id !== "string") return null;
  if (!EVIDENCE_ID.test(id) || !onEvidenceLink)
    return h("span", { class: "ev-link" }, id);
  return h(
    "button",
    {
      type: "button",
      class: "link ev-link",
      title: "Open a summary view of this Evidence",
      onclick: () => onEvidenceLink(id),
    },
    `${id.slice(0, 15)}…${id.slice(-6)}`,
  );
}

/** Lazily expanded JSON tree; children are built only when a node opens. */
export function renderTree(value, { onEvidenceLink, openDepth = 1 } = {}) {
  const root = h("div", { class: "tree" });
  root.append(node(undefined, value, 0));
  return root;

  function node(key, item, depth) {
    if (item === null || typeof item !== "object") {
      return h("div", { class: "row" }, keyLabel(key), scalar(item));
    }
    const entries = Array.isArray(item)
      ? item.map((child, index) => [index, child])
      : Object.entries(item);
    const summary = Array.isArray(item)
      ? `[${entries.length}]`
      : `{${entries.length}}`;
    const details = h(
      "details",
      {},
      h("summary", {}, keyLabel(key), h("span", { class: "meta" }, summary)),
    );
    let rendered = 0;
    const renderPage = () => {
      details.querySelector(":scope > .more")?.remove();
      const end = Math.min(entries.length, rendered + TREE_PAGE);
      for (; rendered < end; rendered++) {
        const [childKey, child] = entries[rendered];
        details.append(node(childKey, child, depth + 1));
      }
      if (rendered < entries.length) {
        details.append(
          h(
            "div",
            { class: "more" },
            h(
              "button",
              { type: "button", class: "link", onclick: renderPage },
              `Show ${Math.min(TREE_PAGE, entries.length - rendered)} more of ${entries.length - rendered}`,
            ),
          ),
        );
      }
    };
    details.addEventListener("toggle", () => {
      if (details.open && rendered === 0) renderPage();
    });
    if (depth < openDepth) details.open = true;
    return details;
  }

  function keyLabel(key) {
    if (key === undefined) return null;
    return h(
      "span",
      { class: "key" },
      typeof key === "number" ? `${key}: ` : `${key}: `,
    );
  }

  function scalar(item) {
    if (typeof item === "string") {
      if (EVIDENCE_ID.test(item) && onEvidenceLink)
        return evidenceLink(item, onEvidenceLink);
      return h("span", { class: "str" }, JSON.stringify(item));
    }
    if (typeof item === "number")
      return h("span", { class: "num" }, String(item));
    return h("span", { class: "lit" }, String(item));
  }
}

/** Text content blocks exactly as returned. */
export function renderContent(result) {
  const blocks = (result.content ?? []).map((block) => {
    if (block.type === "text")
      return h("pre", { class: "text-block" }, block.text);
    if (
      block.type === "image" &&
      /^image\/(png|jpeg|gif|webp)$/.test(block.mimeType ?? "")
    ) {
      return h("img", {
        src: `data:${block.mimeType};base64,${block.data}`,
        alt: "Tool image output",
        class: "content-image",
      });
    }
    return h("pre", { class: "text-block" }, JSON.stringify(block, null, 2));
  });
  return blocks.length
    ? blocks
    : [h("p", { class: "hint" }, "No content blocks were returned.")];
}
