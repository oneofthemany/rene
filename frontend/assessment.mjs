// Project assessment: how tools relate in one project, and the markdown file
// that carries it into the project folder.
//
// Links between calls are confirmed, never guessed. REA identifies each
// Evidence record by a SHA-256 digest of its content (ev_<64 hex>). When a
// call's arguments name an Evidence ID that an earlier call in the project
// issued (its own Evidence, or the parent Evidence REA says it retained),
// that call used that result: the identifier can't coincide by accident. A referenced ID that no recorded call returned
// (imported, from another project, or from a result too large to keep) is
// kept as an unresolved reference rather than linked to anything.
//
// <project>/.rene/assessment.md is written only after the user agrees for
// that project. The workbench rewrites only the text between its markers;
// everything else in the file belongs to the user and their agent.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ASSESSMENT_FILE = join(".rene", "assessment.md");
const BEGIN = "<!-- rene:generated -->";
const END = "<!-- /rene:generated -->";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/;
const CONFIDENCE = new Set(["observed", "derived", "inferred"]);
// Identical Evidence returned by several calls was returned by each of them.
const MAX_PRODUCERS = 5;

/** REA's structured payload: structuredContent, or a lone JSON text block. */
function payloadOf(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const texts = (result?.content ?? []).filter(
    (block) => block.type === "text",
  );
  if (texts.length !== 1) return undefined;
  try {
    return JSON.parse(texts[0].text);
  } catch {
    return undefined;
  }
}

/**
 * The Evidence IDs a call issued: its result's own Evidence, and the parent
 * Evidence REA says it retained (a summary receipt's parent_evidence_id) when
 * the call wasn't given that ID, so it came from this call rather than into it.
 */
export function issuedEvidence(result, args) {
  if (!result || result.isError) return [];
  const payload = payloadOf(result);
  if (
    typeof payload?.evidence_id !== "string" ||
    !EVIDENCE_ID.test(payload.evidence_id) ||
    !CONFIDENCE.has(payload.confidence)
  )
    return [];
  const issued = [payload.evidence_id];
  const parent = payload.normalized_result?.parent_evidence_id;
  const given = new Set(
    referencedEvidence(args).map((reference) => reference.evidence),
  );
  if (
    typeof parent === "string" &&
    EVIDENCE_ID.test(parent) &&
    !given.has(parent)
  )
    issued.push(parent);
  return issued;
}

/** Every argument whose value is exactly an Evidence ID, with its path. */
function referencedEvidence(args) {
  const found = [];
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (EVIDENCE_ID.test(value)) found.push({ path, evidence: value });
    } else if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
    } else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value))
        walk(item, path ? `${path}.${key}` : key);
    }
  };
  walk(args, "");
  return found;
}

/**
 * Confirmed links into a call: the earlier calls that returned each Evidence
 * ID its arguments name, or an unresolved reference when none did.
 * @param {object} args the call's arguments
 * @param {{ id: string, name: string, startedAt: number, evidence?: string[] }[]} earlier
 *   the project's recorded calls that started before it, newest first
 * @returns {{ from: string | null, tool?: string, arg: string, evidence: string }[]}
 */
export function findLinks(args, earlier) {
  const links = [];
  for (const { path, evidence } of referencedEvidence(args)) {
    const producers = earlier
      .filter((call) => call.evidence?.includes(evidence))
      .slice(0, MAX_PRODUCERS);
    if (producers.length === 0)
      links.push({ from: null, arg: path || "(value)", evidence });
    for (const producer of producers)
      links.push({
        from: producer.id,
        tool: producer.name,
        arg: path || "(value)",
        evidence,
      });
  }
  return links;
}

/**
 * The project's calls recorded before `before` that issued Evidence `args`
 * names, newest first: the only earlier calls findLinks can link to. A call
 * naming no Evidence needs no lookup.
 */
export async function earlierCalls(history, before, args) {
  const named = [
    ...new Set(referencedEvidence(args).map(({ evidence }) => evidence)),
  ];
  if (named.length === 0) return [];
  return history.list({ startedBefore: before, evidence: named });
}

const MAX_CHAIN = 6;
const MAX_PATHS = 2000;
const SHOWN_PATHWAYS = 12;
const SHOWN_LINKS = 15;

/** Tool pathways, confirmed links and usage, from a project's stored summaries. */
export function summarize(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const next = new Map();
  const counted = new Map();
  const usage = new Map();
  let unresolved = 0;
  for (const entry of entries) {
    const use = usage.get(entry.name) ?? { runs: 0, failed: 0, agent: 0 };
    use.runs += 1;
    if (entry.outcome !== "ok") use.failed += 1;
    if (entry.source === "agent") use.agent += 1;
    usage.set(entry.name, use);
    for (const edge of entry.links ?? []) {
      if (edge.from === null) {
        unresolved += 1;
        continue;
      }
      // A link to a call history has since pruned has no endpoint to show.
      if (!byId.has(edge.from)) continue;
      next.set(edge.from, [...(next.get(edge.from) ?? []), entry.id]);
      const key = `${edge.tool}\u0000${entry.name}\u0000${edge.arg}`;
      counted.set(key, (counted.get(key) ?? 0) + 1);
    }
  }

  // Chains start at calls whose Evidence others used but that used none.
  const fed = new Set([...next.values()].flat());
  const pathways = new Map();
  let walked = 0;
  const walk = (id, trail) => {
    if (walked >= MAX_PATHS) return;
    const children = (next.get(id) ?? []).filter(
      (child) => !trail.includes(child),
    );
    if (children.length === 0 || trail.length >= MAX_CHAIN) {
      walked += 1;
      if (trail.length < 2) return;
      const names = trail.map((step) => byId.get(step).name);
      const key = names.join(" → ");
      const last = byId.get(trail.at(-1));
      const pathway = pathways.get(key) ?? {
        names,
        runs: 0,
        ok: 0,
        examples: [],
      };
      pathway.runs += 1;
      if (last.outcome === "ok") pathway.ok += 1;
      if (pathway.examples.length < 2) pathway.examples.push(trail[0]);
      pathways.set(key, pathway);
      return;
    }
    for (const child of [...new Set(children)]) walk(child, [...trail, child]);
  };
  for (const id of next.keys()) if (!fed.has(id)) walk(id, [id]);

  return {
    calls: entries.length,
    pathways: [...pathways.values()].sort((a, b) => b.runs - a.runs),
    unresolved,
    links: [...counted.entries()]
      .map(([key, count]) => {
        const [from, to, arg] = key.split("\u0000");
        return { from, to, arg, count };
      })
      .sort((a, b) => b.count - a.count),
    usage: [...usage.entries()]
      .map(([name, use]) => ({ name, ...use }))
      .sort((a, b) => b.runs - a.runs),
  };
}

const shortId = (id) => id.slice(-8);

export const SURVEY_TOOL = "survey_project_directory";
const SHOWN_FOLDERS = 30;
const SHOWN_TYPES = 30;

const size = (bytes) =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 ** 2
      ? `${(bytes / 1024).toFixed(1)} KiB`
      : bytes < 1024 ** 3
        ? `${(bytes / 1024 ** 2).toFixed(1)} MiB`
        : `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
const cell = (text) => String(text).replaceAll("|", "\\|");

/**
 * The newest successful survey_project_directory call in a history, with
 * the survey its Evidence carries, or undefined when there is none.
 */
export async function latestSurvey(history) {
  const [entry] = await history.list({
    name: SURVEY_TOOL,
    outcome: "ok",
    limit: 1,
  });
  if (!entry) return undefined;
  const survey = payloadOf(await history.result(entry.id))?.normalized_result;
  return survey && Array.isArray(survey.file_types)
    ? { entry, survey }
    : undefined;
}

/** Folder structure, file types and the tools that apply, from one survey. */
function surveyLines(latest) {
  if (!latest)
    return [
      "## Folder structure",
      "",
      "_Not surveyed yet: the workbench runs survey_project_directory when the folder is opened._",
      "",
    ];
  const { entry, survey } = latest;
  const lines = [
    `_From survey_project_directory, ${new Date(entry.startedAt).toISOString()} (entry ${shortId(entry.id)})._`,
    "",
    "## Folder structure",
    "",
    "| Folder | Files | Size | Main types |",
    "| --- | --- | --- | --- |",
  ];
  for (const folder of survey.structure.slice(0, SHOWN_FOLDERS))
    lines.push(
      `| \`${cell(folder.path)}\` | ${folder.files} | ${size(folder.bytes)} | ${folder.top_types.map(({ type, files }) => `${type} (${files})`).join(", ")} |`,
    );
  if (survey.structure.length > SHOWN_FOLDERS)
    lines.push(`| … ${survey.structure.length - SHOWN_FOLDERS} more | | | |`);
  lines.push(
    "",
    "## File types",
    "",
    "| Type | Decided by | Files | Size | Examples |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const type of survey.file_types.slice(0, SHOWN_TYPES))
    lines.push(
      `| ${type.type} | ${type.detection} | ${type.files} | ${size(type.bytes)} | ${type.examples.map((path) => `\`${cell(path)}\``).join(", ")} |`,
    );
  if (survey.file_types.length > SHOWN_TYPES)
    lines.push(`| … ${survey.file_types.length - SHOWN_TYPES} more | | | | |`);
  lines.push("", "## Applicable tools", "");
  if (survey.applicable_tools.length === 0)
    lines.push("_No file type here is one an REA tool takes directly._");
  for (const tool of survey.applicable_tools)
    lines.push(
      `- \`${tool.tool}\`${tool.access === "open_binary" && tool.tool !== "open_binary" ? " (after open_binary)" : ""} — ${tool.file_types.join(", ")}; e.g. ${tool.examples.map((path) => `\`${path}\``).join(", ")}`,
    );
  const coverage = survey.coverage;
  lines.push(
    "",
    "## Coverage",
    "",
    coverage.complete
      ? `Complete: ${coverage.files} files in ${coverage.directories} folders, ${size(coverage.bytes)}.`
      : `Partial: ${coverage.files} files in ${coverage.directories} folders, ${size(coverage.bytes)}. Types in folders not walked are unknown, not absent.`,
  );
  if (coverage.excluded_folders.length)
    lines.push(
      `- Not walked (excluded): ${coverage.excluded_folders.map((path) => `\`${path}\``).join(", ")}`,
    );
  if (coverage.depth_limit_folders.length)
    lines.push(
      `- Not walked (past max_depth): ${coverage.depth_limit_folders.length} folders`,
    );
  if (coverage.entry_limit_reached)
    lines.push("- The entry limit was reached.");
  if (coverage.unreadable.length)
    lines.push(`- Unreadable: ${coverage.unreadable.length} entries`);
  lines.push("");
  return lines;
}

export const MAP_TOOL = "map_source_graph";

/**
 * The newest successful map_source_graph call in a history, with the map
 * its Evidence carries, or undefined when there is none.
 */
export async function latestCodeMap(history) {
  const [entry] = await history.list({
    name: MAP_TOOL,
    outcome: "ok",
    limit: 1,
  });
  if (!entry) return undefined;
  const map = payloadOf(await history.result(entry.id))?.normalized_result;
  return map && Array.isArray(map.most_called_symbols)
    ? { entry, map }
    : undefined;
}

/**
 * Where to start in the code: CodeGraph's map of the project's index (the
 * files most others depend on, the symbols called from most places), with
 * the call it came from and when the index was built.
 */
function codeMapLines(latest) {
  const lines = ["## Code map", ""];
  if (!latest)
    return [
      ...lines,
      "_No code map yet: build the project's source graph with index_source_graph; the workbench then maps it with map_source_graph._",
      "",
    ];
  const { entry, map } = latest;
  lines.push(
    `_From map_source_graph, ${new Date(entry.startedAt).toISOString()} (entry ${shortId(entry.id)}); index last built ${map.last_indexed_at ?? "at an unknown time"}: ${map.files} files, ${map.symbols} symbols, ${map.links} links. Test and generated files are left out of the rankings. Ask explore_source_graph about any of these before reading files one by one._`,
    "",
    `Languages: ${map.languages
      .slice(0, 8)
      .map(({ language, files }) => `${language} (${files})`)
      .join(", ")}`,
    "",
    "| Most depended-on file | Dependent files |",
    "| --- | --- |",
  );
  for (const file of map.most_depended_on_files)
    lines.push(`| \`${cell(file.file)}\` | ${file.dependent_files} |`);
  lines.push(
    "",
    "| Most-called symbol | Kind | Where | Callers |",
    "| --- | --- | --- | --- |",
  );
  for (const symbol of map.most_called_symbols)
    lines.push(
      `| \`${cell(symbol.name)}\` | ${symbol.kind} | \`${cell(symbol.file)}:${symbol.line}\` | ${symbol.callers} |`,
    );
  lines.push("");
  return lines;
}

const SHOWN_TURNS = 15;
const QUOTE = 300;

const quote = (text) => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return `"${flat.length > QUOTE ? `${flat.slice(0, QUOTE)}…` : flat}"`;
};

/**
 * Recent conversation turns, newest first: what was asked, which rene calls
 * followed (with their history entry ids) and what the agent concluded,
 * quoted rather than summarised.
 */
function conversationLines(turns) {
  const lines = ["## Conversations", ""];
  if (!turns?.length)
    return [
      ...lines,
      "_None recorded yet: Claude Code sessions started from the workbench are captured with their transcripts._",
      "",
    ];
  for (const turn of [...turns].reverse().slice(0, SHOWN_TURNS)) {
    const when = turn.at
      ? new Date(turn.at).toISOString().slice(0, 16).replace("T", " ")
      : "?";
    lines.push(
      `- ${when} · ${turn.agent ?? "Agent"} — asked: ${turn.prompt ? quote(turn.prompt) : "_(no prompt)_"}`,
    );
    if (turn.calls.length)
      lines.push(
        `  - rene calls: ${turn.calls
          .map(
            (call) =>
              `\`${call.tool}\`${call.historyId ? ` (${shortId(call.historyId)})` : " (not recorded)"}`,
          )
          .join(", ")}`,
      );
    if (turn.conclusion) lines.push(`  - concluded: ${quote(turn.conclusion)}`);
  }
  if (turns.length > SHOWN_TURNS)
    lines.push(
      `- … ${turns.length - SHOWN_TURNS} earlier turns in the workbench's history`,
    );
  lines.push("");
  return lines;
}

/**
 * Threads and the topics under them, from record_topic declarations, with
 * full ids so an agent can declare work under an existing thread.
 */
function topicLines(tree) {
  const lines = ["## Topics", ""];
  if (!tree?.threads?.length)
    return [
      ...lines,
      "_None declared yet: agents (or you) declare threads and topics with record_topic._",
      "",
    ];
  const describe = (node) =>
    `**${node.title}** — ${node.kind}, ${node.status}, ${node.turns.length} turn${node.turns.length === 1 ? "" : "s"} (\`${node.topic_id}\`)`;
  const walk = (node, depth) => {
    const indent = "  ".repeat(depth);
    lines.push(
      `${indent}- ${describe(node)}${node.orphan ? " — parent not found" : ""}`,
    );
    if (node.summary) lines.push(`${indent}  - ${quote(node.summary)}`);
    for (const relation of node.relations ?? [])
      lines.push(
        `${indent}  - ${relation.relation.replace("_", " ")} \`${relation.topic_id}\``,
      );
    for (const fact of node.facts ?? [])
      lines.push(
        `${indent}  - shares ${fact.shared.map((item) => `${item.kind} \`${item.value}\``).join(", ")}${fact.more ? ` and ${fact.more} more` : ""} with \`${fact.topic_id}\``,
      );
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const thread of tree.threads) walk(thread, 0);
  if (tree.loose_turns?.length)
    lines.push(`- ${tree.loose_turns.length} turns aren't in any topic yet`);
  lines.push("");
  return lines;
}

/**
 * The generated block, markers included.
 * @param {{ summary: object, survey?: object, codeMap?: object,
 *   turns?: object[], topics?: object }} parts what summarize, latestSurvey,
 *   latestCodeMap, the conversation turns and the topic tree produced
 */
export function generatedBlock({ summary, survey, codeMap, turns, topics }) {
  const lines = [
    BEGIN,
    "<!-- Rewritten by the REA workbench from this project's call history. Links are confirmed by Evidence ID: a call named Evidence (ev_<sha256>) an earlier call returned. Edit outside these markers. -->",
    "",
    ...surveyLines(survey),
    ...codeMapLines(codeMap),
    ...topicLines(topics),
    ...conversationLines(turns),
    "## Pathways",
    "",
  ];
  if (summary.pathways.length === 0)
    lines.push(
      "_None yet: no call has named Evidence an earlier call returned._",
    );
  summary.pathways.slice(0, SHOWN_PATHWAYS).forEach((pathway, index) => {
    lines.push(
      `${index + 1}. ${pathway.names.map((name) => `\`${name}\``).join(" → ")} — ${pathway.runs} run${pathway.runs === 1 ? "" : "s"}, ${pathway.ok} ended ok (from ${pathway.examples.map(shortId).join(", ")})`,
    );
  });
  lines.push("", "## Evidence links", "");
  if (summary.links.length === 0) lines.push("_None yet._");
  for (const link of summary.links.slice(0, SHOWN_LINKS))
    lines.push(
      `- \`${link.from}\` Evidence → \`${link.to}\` \`${link.arg}\` (${link.count}×)`,
    );
  if (summary.unresolved)
    lines.push(
      `- ${summary.unresolved} reference${summary.unresolved === 1 ? "" : "s"} to Evidence no recorded call returned (imported, from elsewhere, or from a result too large to keep)`,
    );
  lines.push("", "## Tools used", "");
  lines.push(
    "| Tool | Runs | Failed | By agent |",
    "| --- | --- | --- | --- |",
  );
  for (const use of summary.usage)
    lines.push(
      `| \`${use.name}\` | ${use.runs} | ${use.failed} | ${use.agent} |`,
    );
  lines.push(
    "",
    `_${summary.calls} calls in the workbench's history for this folder; ids are history entry ids._`,
    END,
  );
  return lines.join("\n");
}

const template = (name, block) =>
  [
    `# Project assessment — ${name}`,
    "",
    "<!-- Project memory for people and agents working in this folder with REA.",
    "     The workbench updates only the generated section; everything else is yours. -->",
    "",
    "## Target",
    "",
    "_What is being analysed, and what is known about it._",
    "",
    "## Rules",
    "",
    "_How to work on this target: which engine or tools to prefer, what to avoid, and why._",
    "",
    block,
    "",
    "## Findings",
    "",
    "_Conclusions, each with the history entry ids it rests on._",
    "",
    "## Open questions",
    "",
    "_What is still unknown._",
    "",
  ].join("\n");

// The session briefing: what an agent needs at the start of a session, from
// the same parts as the assessment, small enough to hand it whole (the topic
// gate does, when a session starts). The assessment stays the full record.
export const BRIEFING_FILE = join(".rene", "briefing.md");
const BRIEF_SECTION_CHARS = { Target: 1_500, Rules: 6_000 };
// Claude Code hands a hook's context over inline only up to 10,000
// characters (more goes to a file the agent must read): the whole session
// briefing (sessionBriefing.mjs) is kept under that.
const BRIEF_FILES = 6;
const BRIEF_SYMBOLS = 4;
const BRIEF_TOPICS_PER_THREAD = 4;

/** A section of the assessment's own (not generated) text, by its heading. */
function sectionText(markdown, heading, limit) {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) return undefined;
  const body = markdown.slice(start + heading.length + 5);
  const ends = [body.indexOf("\n## "), body.indexOf(BEGIN)].filter(
    (index) => index !== -1,
  );
  const text = body.slice(0, Math.min(body.length, ...ends)).trim();
  if (!text) return undefined;
  return text.length > limit
    ? `${text.slice(0, limit)}… (the rest in ${ASSESSMENT_FILE})`
    : text;
}

/**
 * Open work, by thread: each thread that is open or holds open topics, and
 * its open topics, with the ids a declaration continues them by.
 */
function openTopicLines(tree) {
  const lines = [];
  const open = (node) => node.status === "open";
  const holdsOpen = (node) =>
    open(node) || node.children.some((child) => holdsOpen(child));
  let closed = 0;
  const newest = (a, b) =>
    Date.parse(b.declared_at ?? "") - Date.parse(a.declared_at ?? "");
  const walk = (node, depth) => {
    const openChildren = node.children.filter((child) => holdsOpen(child));
    closed += node.children.length - openChildren.length;
    // The most recently declared open topics; the rest are counted.
    const shown = openChildren.sort(newest).slice(0, BRIEF_TOPICS_PER_THREAD);
    if (openChildren.length > shown.length)
      lines.push(
        `${"  ".repeat(depth)}- and ${openChildren.length - shown.length} older open topics (${ASSESSMENT_FILE}'s Topics)`,
      );
    for (const child of shown) {
      const phase = child.phases?.at(-1)?.name;
      lines.push(
        `${"  ".repeat(depth)}- **${child.title}** — ${child.kind}, ${child.status}${phase ? `, phase ${phase}` : ""} (\`${child.topic_id}\`)`,
      );
      walk(child, depth + 1);
    }
  };
  for (const thread of tree?.threads ?? []) {
    if (!holdsOpen(thread)) {
      closed += 1;
      continue;
    }
    lines.push(
      `- Thread **${thread.title}** — ${thread.status} (\`${thread.topic_id}\`)`,
    );
    walk(thread, 1);
  }
  if (!lines.length) lines.push("_No open topics._");
  if (closed)
    lines.push(
      `- ${closed} closed threads and topics are in ${ASSESSMENT_FILE}'s Topics section.`,
    );
  return lines;
}

/** The session briefing's text. */
export function briefingText(name, assessment, { codeMap, topics }) {
  const lines = [
    `# Session briefing — ${name}`,
    "",
    `_Written by the workbench with ${ASSESSMENT_FILE}, which has the full record (conversations, pathways, the folder survey)._`,
    "",
  ];
  for (const heading of ["Target", "Rules"]) {
    const text = sectionText(assessment, heading, BRIEF_SECTION_CHARS[heading]);
    if (text) lines.push(`## ${heading}`, "", text, "");
  }
  lines.push("## Layout", "");
  if (codeMap) {
    const { map } = codeMap;
    lines.push(
      `Languages: ${map.languages
        .slice(0, 6)
        .map(({ language, files }) => `${language} (${files})`)
        .join(", ")}. Most depended-on files: ${map.most_depended_on_files
        .slice(0, BRIEF_FILES)
        .map((file) => `\`${file.file}\``)
        .join(", ")}. Most-called symbols: ${map.most_called_symbols
        .slice(0, BRIEF_SYMBOLS)
        .map((symbol) => `\`${symbol.name}\` (\`${symbol.file}\`)`)
        .join(
          ", ",
        )}. Ask explore_source_graph before reading files one by one.`,
    );
  } else
    lines.push(
      "_No code map yet: index_source_graph builds the source graph._",
    );
  lines.push("", "## Open topics", "", ...openTopicLines(topics), "");
  return lines.join("\n");
}

async function writeBriefing(folder, name, assessment, parts) {
  const path = join(folder, BRIEFING_FILE);
  const text = briefingText(name, assessment, parts);
  if ((await readFile(path, "utf8").catch(() => undefined)) === text) return;
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  await rename(temporary, path);
}

/** The session briefing's text, or undefined when there is none. */
export const readBriefing = (folder) =>
  readFile(join(folder, BRIEFING_FILE), "utf8").catch(() => undefined);

/**
 * Writes the generated block into the project's assessment, creating the
 * file from the template when there is none, and the session briefing
 * beside it. Returns what happened to the assessment.
 * @returns {Promise<"created" | "updated" | "unchanged" | "markers-missing">}
 */
export async function writeAssessment(folder, name, parts) {
  const path = join(folder, ASSESSMENT_FILE);
  const block = generatedBlock(parts);
  let current;
  try {
    current = await readFile(path, "utf8");
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
  }
  let text;
  if (current === undefined) {
    await mkdir(join(folder, ".rene"), { recursive: true });
    text = template(name, block);
  } else {
    const begin = current.indexOf(BEGIN);
    const end = current.indexOf(END, begin);
    // Someone removed the markers; the block isn't put back against their edit.
    if (begin === -1 || end === -1) {
      await writeBriefing(folder, name, current, parts);
      return "markers-missing";
    }
    text = current.slice(0, begin) + block + current.slice(end + END.length);
    await writeBriefing(folder, name, text, parts);
    if (text === current) return "unchanged";
  }
  if (current === undefined) await writeBriefing(folder, name, text, parts);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, text);
  // An edit made while this was being written wins; ours is retried later.
  const onDisk = await readFile(path, "utf8").catch(() => undefined);
  if (onDisk !== current) {
    await rm(temporary, { force: true });
    return "unchanged";
  }
  await rename(temporary, path);
  return current === undefined ? "created" : "updated";
}

/** The assessment's text, or undefined when there is none. */
export const readAssessment = (folder) =>
  readFile(join(folder, ASSESSMENT_FILE), "utf8").catch(() => undefined);
