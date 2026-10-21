/**
 * The user makes every commit, never an agent. These are the git
 * subcommands that write history or publish it, as a shell command line an
 * agent sends would run them; reading history, staging and unstaging are
 * not among them. Both the workbench's topic gate (frontend/topicGate.mjs)
 * and `rene agent` refuse what this finds.
 *
 * The line is split conservatively at every shell separator, including
 * command substitution, so a git command inside $(…) or `…` is found too:
 * for a refusal rule, finding too much is the safe side.
 */

const HISTORY_WRITES = new Set([
  "commit",
  "commit-tree",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "update-ref",
  "push",
  "pull",
  "subtree",
  "filter-branch",
  "filter-repo",
  "replace",
  "notes",
]);
// Global options whose value is the next word, e.g. git -C <path> commit.
const OPTIONS_WITH_VALUE = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
]);
const LIST_TAGS = /^(?:-l|--list|-n\d*|--sort=.*|--contains)$/u;
const MOVES_BRANCH = /^--(?:soft|hard|keep|merge)$/u;

/** The history-writing subcommand of one git invocation's words after `git`. */
const historyWrite = (words: readonly string[]): string | undefined => {
  let index = 0;
  while (index < words.length && (words[index] as string).startsWith("-")) {
    const option = words[index] as string;
    index += OPTIONS_WITH_VALUE.has(option) && !option.includes("=") ? 2 : 1;
  }
  const subcommand = words[index];
  const rest = words.slice(index + 1);
  if (subcommand === undefined) return undefined;
  if (HISTORY_WRITES.has(subcommand)) return subcommand;
  // Moving a branch to another commit rewrites history; unstaging doesn't.
  if (subcommand === "reset" && rest.some((word) => MOVES_BRANCH.test(word)))
    return "reset";
  // Listing tags and stashes reads; creating or dropping them writes.
  if (subcommand === "tag" && rest.some((word) => !LIST_TAGS.test(word)))
    return "tag";
  if (subcommand === "stash" && !["list", "show"].includes(rest[0] ?? ""))
    return "stash";
  return undefined;
};

/** The history-writing git subcommand a shell command line runs, if any. */
export const gitHistoryWrite = (command: string): string | undefined => {
  for (const segment of command.split(/&&|\|\||[;|\n&()`]|\$\(/u)) {
    const words = segment.trim().split(/\s+/u);
    const git = words.findIndex((word) => /(?:^|\/)git$/u.test(word));
    if (git < 0) continue;
    const found = historyWrite(words.slice(git + 1));
    if (found !== undefined) return found;
  }
  return undefined;
};

/** Why a refused git command is refused, for the agent that sent it. */
export const GIT_HISTORY_RULE =
  "the user makes every commit and every change to git history, never the agent. Leave the changes in the working tree, say what is ready, and ask the user to commit.";
