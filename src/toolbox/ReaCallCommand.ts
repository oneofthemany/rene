/**
 * Recognize a `rea call <tool> [<json>|-]` invocation in a shell command
 * line an agent ran, so a transcript's shell tool use can be tied to the
 * call `rea call` recorded, as an MCP tool use is.
 *
 * The line is split into words with POSIX quoting (single quotes, double
 * quotes with their backslash escapes, and backslashes outside quotes), and
 * into simple commands at unquoted control operators (| & ; < > ( ) and
 * newlines). Each simple command is checked after its leading VAR=value
 * assignments. Expansions ($VAR, $(…), `…`) are not performed: arguments
 * that are not JSON but hold a $ or ` are reported as unknown, and other
 * arguments that are not a JSON object mean rea call refused them, so the
 * command is not a call.
 */

export interface ReaCallCommand {
  readonly tool: string;
  /** The JSON object passed, or null when it is not on the line (stdin, or an expansion). */
  readonly args: Readonly<Record<string, unknown>> | null;
}

const OPERATORS = new Set(["|", "&", ";", "<", ">", "(", ")", "\n"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/u;

/**
 * The text of the double-quoted string opening at `start`, with the
 * backslash escapes that work inside double quotes applied, and the index of
 * its closing quote; undefined when it is never closed.
 */
const doubleQuoted = (
  line: string,
  start: number,
): { text: string; end: number } | undefined => {
  let text = "";
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === '"') return { text, end: index };
    if (char === "\\" && '"\\$`\n'.includes(line[index + 1] ?? "")) {
      index += 1;
      if (line[index] !== "\n") text += line[index];
    } else text += char;
  }
  return undefined;
};

/**
 * Simple commands of a line, each as its words. The shell refuses a line
 * with an unterminated quote, so none of its commands ran.
 */
const simpleCommands = (line: string): string[][] => {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === "'") {
      const end = line.indexOf("'", index + 1);
      if (end === -1) return [];
      word += line.slice(index + 1, end);
      inWord = true;
      index = end;
    } else if (char === '"') {
      const quoted = doubleQuoted(line, index);
      if (quoted === undefined) return [];
      word += quoted.text;
      inWord = true;
      index = quoted.end;
    } else if (char === "\\") {
      index += 1;
      if (index < line.length && line[index] !== "\n") {
        word += line[index];
        inWord = true;
      }
    } else if (char === " " || char === "\t") endWord();
    else if (OPERATORS.has(char)) endCommand();
    else {
      word += char;
      inWord = true;
    }
  }
  endCommand();
  return commands;
};

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

/** The words after the program when a simple command runs rea, else undefined. */
const reaArguments = (
  words: readonly string[],
): readonly string[] | undefined => {
  let start = 0;
  while (start < words.length && ASSIGNMENT.test(words[start] as string))
    start += 1;
  const [program, ...rest] = words.slice(start);
  if (program === undefined) return undefined;
  const name = basename(program);
  if (name === "rea" || name === "rea.mjs") return rest;
  if (
    name === "node" &&
    rest[0] !== undefined &&
    basename(rest[0]) === "rea.mjs"
  )
    return rest.slice(1);
  if (name === "npx") {
    const at = rest.findIndex((word) => !word.startsWith("-"));
    if (at !== -1 && rest[at] === "rea") return rest.slice(at + 1);
  }
  return undefined;
};

const parseObject = (
  text: string,
): Readonly<Record<string, unknown>> | null | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // Text the shell would have expanded is unknown; other text that is not
    // JSON was refused by rea call, so no call was made.
    return /[$`]/u.test(text) ? null : undefined;
  }
  // rea call refuses anything but an object, so no call was made.
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return value as Record<string, unknown>;
};

/** The first `rea call` in a shell command line, if it has one. */
export const parseReaCallCommand = (
  line: string,
): ReaCallCommand | undefined => {
  for (const words of simpleCommands(line)) {
    const rest = reaArguments(words);
    if (rest?.[0] !== "call") continue;
    const [, tool, input, ...extra] = rest;
    if (tool === undefined || !TOOL_NAME.test(tool) || extra.length > 0)
      continue;
    if (input === undefined) return { tool, args: {} };
    if (input === "-") return { tool, args: null };
    const args = parseObject(input);
    if (args === undefined) continue;
    return { tool, args };
  }
  return undefined;
};
