/**
 * What a shell command line an agent ran does with rea: which `rene call`s
 * it makes, and whether it runs anything but rea.
 *
 * Two readers depend on this: the transcript parser, which ties an agent's
 * shell tool use to the call `rene call` recorded, and the workbench's topic
 * gate, which lets an agent's shell run rea and nothing else. The line is
 * read with POSIX quoting (single quotes, double quotes with their backslash
 * escapes, backslashes outside quotes) into simple commands separated by
 * control operators (| || & && ; newline and parentheses). Redirections are
 * taken out of the words they follow, with their targets; a here-document's
 * body is skipped. Expansions are not performed: a $ or ` stays in its word,
 * and a command or process substitution ($(…), `…`, <(…), >(…)) is noted,
 * since it runs a command this reading doesn't see.
 */

export interface ReaCallCommand {
  readonly tool: string;
  /** The JSON object passed, or null when it is not on the line (stdin, or an expansion). */
  readonly args: Readonly<Record<string, unknown>> | null;
}

export interface Redirection {
  readonly operator: string;
  readonly target: string;
}

export interface SimpleCommand {
  /** The control operator before this command; "" for the first. */
  readonly after: string;
  readonly words: readonly string[];
  readonly redirections: readonly Redirection[];
}

export interface ShellLine {
  readonly commands: readonly SimpleCommand[];
  /** A command or process substitution runs a command not in `commands`. */
  readonly substitutes: boolean;
}

const CONTROL = ["&&", "||", ";;", "|&", "|", "&", ";", "\n", "(", ")"];
const REDIRECT = [
  "<<<",
  "<<-",
  "&>>",
  "<<",
  ">>",
  ">&",
  "<&",
  "&>",
  ">|",
  "<>",
  "<",
  ">",
];
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/u;
const TOOL_NAME = /^[a-z][a-z0-9_]*$/u;
const FD = /^\d+$/u;

type Token = {
  readonly kind: "word" | "control" | "redirect";
  readonly value: string;
};

/**
 * The double-quoted string opening at `start`: its text with the escapes
 * that work inside double quotes applied, the index of its closing quote,
 * and whether it holds a command substitution; undefined when never closed.
 */
const doubleQuoted = (
  line: string,
  start: number,
): { text: string; end: number; substitutes: boolean } | undefined => {
  let text = "";
  let substitutes = false;
  for (let index = start + 1; index < line.length; index += 1) {
    const char = line[index] as string;
    if (char === '"') return { text, end: index, substitutes };
    if (char === "\\" && '"\\$`\n'.includes(line[index + 1] ?? "")) {
      index += 1;
      if (line[index] !== "\n") text += line[index];
      continue;
    }
    if (char === "`" || (char === "$" && line[index + 1] === "("))
      substitutes = true;
    text += char;
  }
  return undefined;
};

const operatorAt = (line: string, index: number, operators: string[]) =>
  operators.find((operator) => line.startsWith(operator, index));

/** The here-document delimiters still to be read, with their tab handling. */
interface PendingHeredoc {
  readonly delimiter: string;
  readonly stripTabs: boolean;
}

/** The index just past a here-document body that starts at `start`. */
const skipHeredoc = (
  line: string,
  start: number,
  { delimiter, stripTabs }: PendingHeredoc,
): number => {
  let index = start;
  while (index < line.length) {
    const end = line.indexOf("\n", index);
    const text = line.slice(index, end === -1 ? line.length : end);
    index = end === -1 ? line.length : end + 1;
    if ((stripTabs ? text.replace(/^\t+/u, "") : text) === delimiter) break;
  }
  return index;
};

/** The tokenizer's state while it reads one line. */
interface Lexer {
  readonly line: string;
  readonly tokens: Token[];
  readonly heredocs: PendingHeredoc[];
  substitutes: boolean;
  word: string;
  inWord: boolean;
  quoted: boolean;
  /** Set after << or <<-: the next word is a here-document delimiter. */
  awaitingDelimiter: boolean | undefined;
}

const endWord = (lexer: Lexer) => {
  if (!lexer.inWord) return;
  if (lexer.awaitingDelimiter !== undefined) {
    lexer.heredocs.push({
      delimiter: lexer.word,
      stripTabs: lexer.awaitingDelimiter,
    });
    lexer.awaitingDelimiter = undefined;
  }
  lexer.tokens.push({ kind: "word", value: lexer.word });
  lexer.word = "";
  lexer.inWord = false;
  lexer.quoted = false;
};

const addQuoted = (lexer: Lexer, text: string) => {
  lexer.word += text;
  lexer.inWord = true;
  lexer.quoted = true;
};

/**
 * Reads the quote or backslash escape at `index` into the current word.
 * Returns the index of its last character, undefined when the character
 * doesn't quote, or null when a quote is never closed.
 */
const readQuoting = (
  lexer: Lexer,
  index: number,
): number | null | undefined => {
  const { line } = lexer;
  const char = line[index];
  if (char === "'") {
    const end = line.indexOf("'", index + 1);
    if (end === -1) return null;
    addQuoted(lexer, line.slice(index + 1, end));
    return end;
  }
  if (char === '"') {
    const string = doubleQuoted(line, index);
    if (string === undefined) return null;
    addQuoted(lexer, string.text);
    lexer.substitutes ||= string.substitutes;
    return string.end;
  }
  if (char !== "\\") return undefined;
  const next = line[index + 1];
  if (next !== undefined && next !== "\n") addQuoted(lexer, next);
  return index + 1;
};

/**
 * Reads the redirection or control operator at `index`, ending the word
 * before it, and skips the bodies of here-documents a newline starts.
 * Returns the index of its last character, or undefined when there is none.
 */
const readOperator = (lexer: Lexer, index: number): number | undefined => {
  const { line } = lexer;
  const redirect = operatorAt(line, index, REDIRECT);
  const value = redirect ?? operatorAt(line, index, CONTROL);
  if (value === undefined) return undefined;
  // A file descriptor number written against its redirection (2>…).
  if (redirect && lexer.inWord && !lexer.quoted && FD.test(lexer.word)) {
    lexer.word = "";
    lexer.inWord = false;
  } else endWord(lexer);
  lexer.tokens.push({ kind: redirect ? "redirect" : "control", value });
  if (value === "<<" || value === "<<-")
    lexer.awaitingDelimiter = value === "<<-";
  let last = index + value.length - 1;
  if (value === "\n")
    for (const heredoc of lexer.heredocs.splice(0))
      last = skipHeredoc(line, last + 1, heredoc) - 1;
  return last;
};

/** Tokens of a line; undefined when a quote is never closed (the shell refuses it). */
const tokenize = (
  line: string,
): { tokens: Token[]; substitutes: boolean } | undefined => {
  const lexer: Lexer = {
    line,
    tokens: [],
    heredocs: [],
    substitutes: false,
    word: "",
    inWord: false,
    quoted: false,
    awaitingDelimiter: undefined,
  };
  for (let index = 0; index < line.length; index += 1) {
    const quoting = readQuoting(lexer, index);
    if (quoting === null) return undefined;
    if (quoting !== undefined) {
      index = quoting;
      continue;
    }
    const char = line[index] as string;
    const next = line[index + 1];
    if (char === "`" || (char === "$" && next === "(")) {
      // A command substitution: noted, and kept in the word.
      lexer.substitutes = true;
      lexer.word += char;
      lexer.inWord = true;
    } else if ((char === "<" || char === ">") && next === "(") {
      // A process substitution runs its list like a subshell.
      lexer.substitutes = true;
      endWord(lexer);
      lexer.tokens.push({ kind: "control", value: "(" });
      index += 1;
    } else if (char === " " || char === "\t") endWord(lexer);
    else {
      const operator = readOperator(lexer, index);
      if (operator !== undefined) index = operator;
      else {
        lexer.word += char;
        lexer.inWord = true;
      }
    }
  }
  endWord(lexer);
  return { tokens: lexer.tokens, substitutes: lexer.substitutes };
};

/** Read a shell command line; undefined when the shell would refuse it. */
export const parseShellLine = (line: string): ShellLine | undefined => {
  const read = tokenize(line);
  if (read === undefined) return undefined;
  const commands: SimpleCommand[] = [];
  let after = "";
  let words: string[] = [];
  let redirections: Redirection[] = [];
  const end = (next: string) => {
    if (words.length > 0 || redirections.length > 0)
      commands.push({ after, words, redirections });
    after = next;
    words = [];
    redirections = [];
  };
  for (let index = 0; index < read.tokens.length; index += 1) {
    const token = read.tokens[index] as Token;
    if (token.kind === "control") end(token.value);
    else if (token.kind === "redirect") {
      const target = read.tokens[index + 1];
      redirections.push({
        operator: token.value,
        target: target?.kind === "word" ? target.value : "",
      });
      if (target?.kind === "word") index += 1;
    } else words.push(token.value);
  }
  end("");
  return { commands, substitutes: read.substitutes };
};

const basename = (word: string) => word.slice(word.lastIndexOf("/") + 1);

// rene is the toolkit's name; rea, REA's command, runs the same call, tools and
// daemon, and older transcripts used it.
const TOOLKIT_COMMANDS = new Set(["rene", "rea"]);
const TOOLKIT_SCRIPTS = new Set(["rene.mjs", "rea.mjs"]);

/** The words after the program when a simple command runs rene (or rea), else undefined. */
export const toolkitArguments = (
  words: readonly string[],
): readonly string[] | undefined => {
  let start = 0;
  while (start < words.length && ASSIGNMENT.test(words[start] as string))
    start += 1;
  const [program, ...rest] = words.slice(start);
  if (program === undefined) return undefined;
  const name = basename(program);
  if (TOOLKIT_COMMANDS.has(name) || TOOLKIT_SCRIPTS.has(name)) return rest;
  if (
    name === "node" &&
    rest[0] !== undefined &&
    TOOLKIT_SCRIPTS.has(basename(rest[0]))
  )
    return rest.slice(1);
  if (name === "npx") {
    const at = rest.findIndex((word) => !word.startsWith("-"));
    if (at !== -1 && TOOLKIT_COMMANDS.has(rest[at] as string))
      return rest.slice(at + 1);
  }
  return undefined;
};

/** The words after `rene call`, as rene call reads them. */
export interface CallWords {
  readonly tool: string;
  /** The JSON arguments, `-` for stdin, or undefined for none. */
  readonly input: string | undefined;
  /** The field `--stdin-field` fills with stdin's raw text. */
  readonly stdinField: string | undefined;
}

/**
 * Reads `<tool> [<json> | -] [--stdin-field <field>]`, the flag before or
 * after the arguments; undefined for anything else. stdin can feed the
 * arguments or one field, not both, so --stdin-field needs JSON on the line.
 */
export const parseCallWords = (
  words: readonly string[],
): CallWords | undefined => {
  const [tool, ...rest] = words;
  if (tool === undefined) return undefined;
  let input: string | undefined;
  let stdinField: string | undefined;
  for (let at = 0; at < rest.length; at++) {
    const word = rest[at] as string;
    if (word === "--stdin-field") {
      const field = rest[at + 1];
      if (stdinField !== undefined || field === undefined) return undefined;
      stdinField = field;
      at++;
    } else if (input === undefined) input = word;
    else return undefined;
  }
  if (stdinField !== undefined && (input === undefined || input === "-"))
    return undefined;
  return { tool, input, stdinField };
};

/** The call one simple command makes, if it runs `rene call` with arguments rea accepts. */
export const reaCallOf = (
  words: readonly string[],
): ReaCallCommand | undefined => {
  const rest = toolkitArguments(words);
  if (rest?.[0] !== "call") return undefined;
  const call = parseCallWords(rest.slice(1));
  if (call === undefined || !TOOL_NAME.test(call.tool)) return undefined;
  const { tool, input, stdinField } = call;
  if (input === undefined) return { tool, args: {} };
  if (input === "-") return { tool, args: null };
  // With --stdin-field the arguments are not all on the line.
  if (stdinField !== undefined)
    return reaCallOf(["rea", "call", tool, input]) && { tool, args: null };
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    // Text the shell would have expanded is unknown; other text that is not
    // JSON was refused by rene call, so no call was made.
    return /[$`]/u.test(input) ? { tool, args: null } : undefined;
  }
  // rene call refuses anything but an object, so no call was made.
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return { tool, args: value as Record<string, unknown> };
};

/** Every `rene call` a shell command line makes, in order. */
export const parseReaCallCommands = (line: string): ReaCallCommand[] =>
  (parseShellLine(line)?.commands ?? []).flatMap((command) => {
    const call = reaCallOf(command.words);
    return call === undefined ? [] : [call];
  });

/** Programs that may read a rea command's output from a pipe. */
const OUTPUT_FILTERS = new Set(["head", "tail", "wc", "jq"]);
const OUTPUT_REDIRECT = new Set([">", ">>", "&>", "&>>", ">|", "<>"]);
const OPTION_OR_COUNT = /^(?:-.*|\d+)$/u;

export type ReaOnlyLine =
  | { readonly ok: true; readonly calls: readonly ReaCallCommand[] }
  | { readonly ok: false; readonly reason: string };

/** Why a redirection would let a command write past rea, if it would. */
const redirectionProblem = ({ operator, target }: Redirection) => {
  if (operator === ">&" || operator === "<&")
    return FD.test(target) || target === "-"
      ? undefined
      : `${operator}${target} writes to a file`;
  if (OUTPUT_REDIRECT.has(operator) && target !== "/dev/null")
    return `${operator} ${target} writes a file rene doesn't record`;
  return undefined;
};

/** Why a filter reading rea's output would do more than filter it, if it would. */
const filterProblem = ([program, ...args]: readonly string[]) => {
  const operands = args.filter((word) => !OPTION_OR_COUNT.test(word));
  // jq takes its filter as one operand; a further operand is a file.
  const allowed = program === "jq" ? 1 : 0;
  return operands.length > allowed
    ? `${program} ${operands.slice(allowed).join(" ")} reads a file`
    : undefined;
};

/**
 * Whether a shell command line runs rea and nothing else: every simple
 * command is `rene call` or `rene tools`, or head, tail, wc or jq reading a
 * rea command's output from a pipe; no output is redirected to a file but
 * /dev/null, and no command or process substitution runs. With the calls the
 * line makes, so the gate can see a record_topic among them.
 */
export const reaOnlyShellLine = (line: string): ReaOnlyLine => {
  const parsed = parseShellLine(line);
  if (parsed === undefined)
    return { ok: false, reason: "it has an unterminated quote" };
  if (parsed.substitutes)
    return { ok: false, reason: "it runs a command or process substitution" };
  if (parsed.commands.length === 0)
    return { ok: false, reason: "it runs no command" };
  const calls: ReaCallCommand[] = [];
  for (const command of parsed.commands) {
    const redirected = command.redirections
      .map(redirectionProblem)
      .find((problem) => problem !== undefined);
    if (redirected !== undefined) return { ok: false, reason: redirected };
    const rest = toolkitArguments(command.words);
    if (rest !== undefined) {
      if (rest[0] === "tools") continue;
      const call = reaCallOf(command.words);
      if (call === undefined)
        return {
          ok: false,
          reason: `\`${command.words.join(" ")}\` isn't a rene call or rene tools command`,
        };
      calls.push(call);
      continue;
    }
    const program = basename(command.words[0] ?? "");
    const piped = command.after === "|" || command.after === "|&";
    if (!piped || !OUTPUT_FILTERS.has(program))
      return { ok: false, reason: `${program || "it"} isn't rene` };
    const filtered = filterProblem([program, ...command.words.slice(1)]);
    if (filtered !== undefined) return { ok: false, reason: filtered };
  }
  return { ok: true, calls };
};

const RECEIPT = "rene call: declared topic ";
// What the receipt said before the toolkit was named rene.
const EARLIER_RECEIPT = "rea call: declared topic ";

/**
 * The line `rene call record_topic` writes to stderr on success, so a filter
 * on its stdout doesn't hide the declaration from the topic gate.
 */
export const declarationReceipt = (topicId: string) => `${RECEIPT}${topicId}\n`;

const FAILURE = /^rene call: (\S+) failed; its result is above\.$/mu;

/**
 * The line `rene call` writes to stderr when the tool call failed, so a
 * filter on its stdout doesn't hide the failure from the agent or its
 * transcript.
 */
export const failureReceipt = (tool: string) =>
  `rene call: ${tool} failed; its result is above.\n`;

/** Whether a shell's output holds a failed `rene call`'s receipt. */
export const reneCallFailed = (text: string) => FAILURE.test(text);

/**
 * The topics a shell command's output shows were declared: a declaration
 * receipt, or a line of record_topic's Evidence as `rene call record_topic`
 * prints it on success. A failed declaration prints neither.
 */
export const declaredTopicIds = (output: string): string[] =>
  output.split("\n").flatMap((line) => {
    const receipt = [RECEIPT, EARLIER_RECEIPT].find((prefix) =>
      line.startsWith(prefix),
    );
    if (receipt !== undefined) {
      const id = line.slice(receipt.length).trim();
      return id === "" ? [] : [id];
    }
    if (!line.startsWith("{")) return [];
    let evidence: unknown;
    try {
      evidence = JSON.parse(line);
    } catch {
      return [];
    }
    const { operation, normalized_result: result } = (evidence ?? {}) as {
      operation?: unknown;
      normalized_result?: { topic_id?: unknown } | null;
    };
    return operation === "record_topic" && typeof result?.topic_id === "string"
      ? [result.topic_id]
      : [];
  });
