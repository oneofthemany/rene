// Minimal Markdown-to-DOM for REA workflow briefs: headings, paragraphs,
// bullet and numbered lists with indented continuation lines, and inline code.
// It builds DOM nodes only, so brief text can never become markup.

import { h } from "./render.js";

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+[.)]\s+(.*)$/;

/**
 * @param {string} text
 * @param {(code: string) => Node | null} renderCode returns a replacement for
 *   an inline code span, or null to render it as <code>.
 */
export function renderMarkdown(text, renderCode = () => null) {
  const blocks = [];
  let paragraph = [];
  let list;

  const inline = (source) =>
    source.split(/(`[^`]+`)/).map((part) => {
      if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
        const code = part.slice(1, -1);
        return renderCode(code) ?? h("code", {}, code);
      }
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
  const addItem = (tag, content) => {
    flushParagraph();
    if (list?.tag !== tag) {
      flushList();
      list = { tag, element: h(tag) };
    }
    list.element.append(h("li", {}, h("div", {}, inline(content))));
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") {
      flushParagraph();
      continue;
    }
    // Indented lines continue the current list item.
    if (list && /^\s{2,}/.test(line)) {
      list.element.lastElementChild.append(
        h("div", { class: "continuation" }, inline(trimmed)),
      );
      continue;
    }
    const heading = HEADING.exec(trimmed);
    const bullet = BULLET.exec(trimmed);
    const numbered = NUMBERED.exec(trimmed);
    if (heading) {
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
  flushParagraph();
  flushList();
  return blocks;
}
