// What a GitHub Copilot CLI session working in this project may use.
//
// rene owns reading, writing and searching the project, so that every local
// action is recorded in the project's history as Evidence. An instruction
// alone does not hold that line: an agent that has read AGENTS.md can still
// reach for its own reader, and has. Taking the tools away removes the
// choice, and leaves `rene call` as the only way to touch the project.
//
// The shell stays allowed, because that is how `rene call` runs; rene's own
// toolbox applies the consent rule to the commands within it.

/** Copilot CLI's own file and search tools, which rene's tools replace. */
export const COPILOT_DENIED_TOOLS = ["view", "edit", "create", "grep", "glob"];

/**
 * Copilot CLI arguments for the cli toolkit: rene's commands pre-approved,
 * and the tools it replaces taken out of the session.
 *
 * `--excluded-tools` is what removes a tool ("these tools will not be
 * available to the model"); `--deny-tool` only withholds permission for one,
 * and a session started with `--deny-tool edit` still edited a file with it.
 * Both are passed: the exclusion is the line, the denial is the backstop if a
 * tool is ever reachable by another name. Each value is attached to its own
 * flag with `=`, because both options take a variadic list and would
 * otherwise swallow the caller's own arguments that follow.
 */
export const copilotToolkitArguments = () => [
  "--allow-tool=shell(rene)",
  "--allow-tool=shell(rea)",
  ...COPILOT_DENIED_TOOLS.flatMap((tool) => [
    `--excluded-tools=${tool}`,
    `--deny-tool=${tool}`,
  ]),
];
