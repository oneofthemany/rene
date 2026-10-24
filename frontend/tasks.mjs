// The project's tasks: the work TODO.md and docs/plans/*.md list, each with a
// stable id, its status, the estimate its text gives and (linkTasks) the
// topic declared for it. This module owns reading them; the session briefing
// and the usage bar's budget take its tasks rather than reading the files.
//
// Headings come from CodeGraph's own Markdown extractor
// (packages/codegraph/src/extraction/markdown-extractor.ts), so a task's
// section is the same `section` node the source graph indexes, named by the
// same qualified name (`TODO.md#Agent usage and budget`), and its `documents`
// links can be joined to it. A task's id is that section and the item's number
// (or, unnumbered, its lead): neither changes when the item is marked done.
// A number does change when items are inserted or moved, so a task can carry
// its own id in its text (`<!-- task: usage-tasks -->`), which is then its id
// and `stable`; the section and number are only the fallback.
// Each task names the section it is listed `under` (its id's first part) and
// its own `section` in the graph: a list item's is the one it sits in, a
// numbered heading's is its own.

import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

const TODO = "TODO.md";
const PLANS = join("docs", "plans");
const EXTRACTOR = "../packages/codegraph/dist/extraction/markdown-extractor.js";
const LEAD_ID_CHARS = 40;

let extractor;
/** CodeGraph's MarkdownExtractor, or the reason it can't be loaded. */
function markdownExtractor() {
  if (extractor) return extractor;
  try {
    extractor = {
      MarkdownExtractor: createRequire(import.meta.url)(EXTRACTOR)
        .MarkdownExtractor,
    };
  } catch (error) {
    extractor = {
      unavailable: `CodeGraph's Markdown extractor isn't built (packages/codegraph: npm run build:cached): ${error.message}`,
    };
  }
  return extractor;
}

/** A file's sections, as the source graph indexes them, innermost last. */
function sectionsOf(file, markdown) {
  const { MarkdownExtractor, unavailable } = markdownExtractor();
  if (unavailable) throw new Error(unavailable);
  return new MarkdownExtractor(file, markdown)
    .extract()
    .nodes.filter((node) => node.kind === "section")
    .map((node) => ({
      name: node.name,
      qualifiedName: node.qualifiedName,
      startLine: node.startLine,
      endLine: node.endLine,
    }));
}

/** The innermost section holding a 1-based line, or the file above them. */
const sectionAt = (sections, line, file) =>
  sections
    .filter((section) => section.startLine <= line && line <= section.endLine)
    .at(-1)?.qualifiedName ?? file;

/**
 * A task's own id, written in its text as `<!-- task: usage-tasks -->`: it
 * stays the task's when items are renumbered, moved or retitled.
 */
const MARKER = /<!--\s*task:\s*([\w.-]+)\s*-->/u;
const markerOf = (text) => MARKER.exec(text)?.[1] ?? null;

/** The model calls a task's text budgets: "40–70 calls". */
function estimateOf(text) {
  const range = /(\d+)\s*[–-]\s*(\d+)\s+calls\b/u.exec(text);
  if (!range) return null;
  const [low, high] = [Number(range[1]), Number(range[2])];
  return low <= high ? { model_calls: { low, high } } : null;
}

const ITEM = /^(?:(\d+)\.|-)\s+\*\*(.+?)\*\*:?\s*(.*)$/u;
const HEADING = /^#{1,6}\s/u;

/**
 * TODO.md's items: each bold-led item (`1. **…**` or `- **…**`) at the start
 * of a line. An item reads as done when its lead, or the words just after
 * it, start with "Done"; as started when they start with "Started". A lead
 * ending in a colon labels a note ("Baseline (SQLite):"), not a task.
 */
function todoTasks(file, markdown, sections) {
  const lines = markdown.split("\n");
  const starts = [];
  lines.forEach((line, index) => {
    if (ITEM.test(line)) starts.push(index);
  });
  return starts.map((index, position) => {
    const [, number, lead, after] = ITEM.exec(lines[index]);
    let end = starts[position + 1] ?? lines.length;
    const heading = lines
      .slice(index + 1, end)
      .findIndex((line) => HEADING.test(line));
    if (heading !== -1) end = index + 1 + heading;
    const state = /^(done|started)\b/iu.exec(lead) ?? /^(done)\b/iu.exec(after);
    const title = lead.replace(/^(done|started)\b[^:]*:\s*/iu, "");
    const section = sectionAt(sections, index + 1, file);
    const text = lines.slice(index, end).join("\n");
    const marker = markerOf(text);
    return {
      id:
        marker ??
        `${section} › ${number ? `${number}.` : title.slice(0, LEAD_ID_CHARS)}`,
      stable: marker !== null,
      file,
      under: section,
      section,
      line: index + 1,
      endLine: end,
      number: number ? Number(number) : null,
      title,
      status: state ? state[1].toLowerCase() : "open",
      note: title.endsWith(":"),
      estimate: estimateOf(text),
    };
  });
}

const NUMBERED = /^(\d+)\.\s+(.+?)$/u;
const BUILT = /\s+[—–-]+\s+(built|done)\s*$/iu;

/**
 * A plan's numbered headings (`### 3. Subsystems`), each a step: done when
 * its heading says so ("— built", "— done") or is struck through.
 */
function planTasks(file, markdown, sections) {
  const lines = markdown.split("\n");
  return sections.flatMap((section) => {
    const numbered = NUMBERED.exec(section.name);
    if (!numbered) return [];
    const [, number, named] = numbered;
    const heading = named.replace(MARKER, "").trim();
    const parent = section.qualifiedName.slice(0, -(section.name.length + 1));
    const done = BUILT.exec(heading) ?? /^~~.*~~$/u.exec(heading);
    // Its own text: the heading line and the body up to its first subheading.
    const body = lines.slice(section.startLine - 1, section.endLine);
    const sub = body.slice(1).findIndex((line) => HEADING.test(line));
    const text = (sub === -1 ? body : body.slice(0, sub + 1)).join("\n");
    const marker = markerOf(text);
    return [
      {
        id: marker ?? `${parent} › ${number}.`,
        stable: marker !== null,
        file,
        under: parent,
        section: section.qualifiedName,
        line: section.startLine,
        endLine: section.endLine,
        number: Number(number),
        title: heading.replace(BUILT, "").replace(/^~~|~~$/gu, ""),
        status: done ? "done" : "open",
        note: false,
        estimate: estimateOf(text),
      },
    ];
  });
}

/**
 * One file's tasks, from its text: TODO.md's bold-led items and every file's
 * numbered headings.
 * @param {string} file the file's path in the project (`TODO.md`)
 * @param {string} markdown its text
 */
export function tasksOf(file, markdown) {
  const sections = sectionsOf(file, markdown);
  return [
    ...(file === TODO ? todoTasks(file, markdown, sections) : []),
    ...planTasks(file, markdown, sections),
  ].sort((a, b) => a.line - b.line);
}

/**
 * The project's tasks: TODO.md's, then each plan's in docs/plans, in file
 * order. A file that can't be read is left out and named in `missing`; when
 * the extractor can't be loaded, `unavailable` says why and there are none.
 * @param {string} folder the project folder
 */
export async function projectTasks(folder) {
  const { unavailable } = markdownExtractor();
  if (unavailable) return { tasks: [], files: [], missing: [], unavailable };
  const plans = await readdir(join(folder, PLANS)).catch(() => []);
  const files = [
    TODO,
    ...plans
      .filter((name) => name.endsWith(".md"))
      .sort()
      .map((name) => `${PLANS}/${name}`),
  ];
  const texts = await Promise.all(
    files.map((file) =>
      readFile(join(folder, file), "utf8").catch(() => undefined),
    ),
  );
  return {
    tasks: files.flatMap((file, index) =>
      texts[index] === undefined ? [] : tasksOf(file, texts[index]),
    ),
    files: files.filter((_, index) => texts[index] !== undefined),
    missing: files.filter((_, index) => texts[index] === undefined),
    unavailable: null,
  };
}

/**
 * Tasks with the topic declared for each (record_topic's `task`): its latest
 * declaration's topic, an open one over a closed one.
 * @param {object[]} tasks projectTasks's tasks
 * @param {Iterable<object>} topics currentTopics's topics
 */
export function linkTasks(tasks, topics) {
  const byTask = new Map();
  for (const topic of topics) {
    if (!topic.task) continue;
    const known = byTask.get(topic.task);
    const rank = (entry) => [
      entry.status === "open" ? 1 : 0,
      Date.parse(entry.declared_at ?? "") || 0,
    ];
    const [open, at] = rank(topic);
    const [knownOpen, knownAt] = known ? rank(known) : [-1, 0];
    if (open > knownOpen || (open === knownOpen && at > knownAt))
      byTask.set(topic.task, topic);
  }
  return tasks.map((task) => {
    const topic = byTask.get(task.id);
    return {
      ...task,
      topic: topic
        ? { id: topic.topic_id, title: topic.title, status: topic.status }
        : null,
    };
  });
}
