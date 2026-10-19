// Minimal Markdown-to-DOM for REA workflow briefs and project assessments:
// headings, paragraphs, bullet and numbered lists with indented continuation
// lines, pipe tables, block quotes, rules, and inline code, bold and italic.
// HTML comments are dropped. It builds DOM nodes only, so text from a brief
// or a project folder can never become markup.

import { h } from "./render.js";

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\|.*\|$/;
const TABLE_RULE = /^\|(?:\s*:?-{3,}:?\s*\|)+$/;
const RULE = /^(?:-{3,}|\*{3,}|_{3,})$/;
const QUOTE = /^>\s?(.*)$/;
// Inline spans, in priority order: code, bold, italic.
const INLINE =
  /(`[^`]+`|\*\*[^*]+\*\*|(?<![\w*])_[^_]+_(?![\w])|(?<![\w*])\*[^*\s][^*]*\*(?![\w*]))/;

/** Table cells, honouring \| as a literal pipe. */
const cells = (row) =>
  row
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));

/**
 * @param {string} text
 * @param {(code: string) => Node | null} renderCode returns a replacement for
 *   an inline code span, or null to render it as <code>.
 */
export function renderMarkdown(text, renderCode = () => null) {
  const blocks = [];
  let paragraph = [];
  let list;
  let table;
  let quote;

  const inline = (source) =>
    source.split(INLINE).map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        const code = part.slice(1, -1);
        return renderCode(code) ?? h("code", {}, code);
      }
      if (part.length > 4 && part.startsWith("**") && part.endsWith("**"))
        return h("strong", {}, part.slice(2, -2));
      if (
        part.length > 2 &&
        ((part.startsWith("_") && part.endsWith("_")) ||
          (part.startsWith("*") && part.endsWith("*")))
      )
        return h("em", {}, part.slice(1, -1));
      return part;
    });
  const flushParagraph = () => {
    if (paragraph.length) blocks.push(h("p", {}, inline(paragraph.join(" "))));
    paragraph = [];
  };
  const flushList = () => {
    if (list) blocks.push(list.element);
    list = undefined;
  };
  const flushTable = () => {
    if (table) blocks.push(h("div", { class: "md-table" }, table));
    table = undefined;
  };
  const flushQuote = () => {
    if (quote) blocks.push(h("blockquote", {}, inline(quote.join(" "))));
    quote = undefined;
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushTable();
    flushQuote();
  };
  const addItem = (tag, content) => {
    flushParagraph();
    flushTable();
    flushQuote();
    if (list?.tag !== tag) {
      flushList();
      list = { tag, element: h(tag) };
    }
    list.element.append(h("li", {}, h("div", {}, inline(content))));
  };

  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed === "") {
      flushAll();
      continue;
    }
    // Indented lines continue the current list item.
    if (list && /^\s{2,}/.test(line)) {
      const nested = BULLET.exec(trimmed);
      list.element.lastElementChild.append(
        nested
          ? h("ul", { class: "nested" }, h("li", {}, inline(nested[1])))
          : h("div", { class: "continuation" }, inline(trimmed)),
      );
      continue;
    }
    if (TABLE_ROW.test(trimmed)) {
      if (!table) {
        flushParagraph();
        flushList();
        flushQuote();
        const header = cells(trimmed);
        // A header row needs the rule under it; otherwise it's a plain row.
        if (TABLE_RULE.test(lines[index + 1]?.trim() ?? "")) {
          index += 1;
          table = h(
            "table",
            {},
            h(
              "thead",
              {},
              h(
                "tr",
                {},
                header.map((cell) => h("th", {}, inline(cell))),
              ),
            ),
            h("tbody"),
          );
          continue;
        }
        table = h("table", {}, h("tbody"));
      }
      table.tBodies[0].append(
        h(
          "tr",
          {},
          cells(trimmed).map((cell) => h("td", {}, inline(cell))),
        ),
      );
      continue;
    }
    flushTable();
    const quoted = QUOTE.exec(trimmed);
    if (quoted) {
      flushParagraph();
      flushList();
      (quote ??= []).push(quoted[1]);
      continue;
    }
    flushQuote();
    const heading = HEADING.exec(trimmed);
    const bullet = BULLET.exec(trimmed);
    const numbered = NUMBERED.exec(trimmed);
    if (RULE.test(trimmed)) {
      flushAll();
      blocks.push(h("hr"));
    } else if (heading) {
      flushParagraph();
      flushList();
      const level = Math.min(6, heading[1].length + 2);
      blocks.push(h(`h${level}`, {}, inline(heading[2])));
    } else if (bullet) {
      addItem("ul", bullet[1]);
    } else if (numbered) {
      addItem("ol", numbered[1]);
    } else {
      flushList();
      paragraph.push(trimmed);
    }
  }
  flushAll();
  return blocks;
}
