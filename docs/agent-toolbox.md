# Agent toolbox

rene aims to be an agent's whole toolbox, in any folder it works in: every
action an agent takes is an REA tool call, so it is recorded with its
arguments and result, linked to the conversation that led to it, and part of
the project's audit trail. An action taken with an agent's own built-in tool
(a shell, a file editor) leaves no such record.

This page maps the tools a coding agent such as Claude Code brings with it to
their REA equivalents, and says which exist.

## Paths and authority

The toolbox tools act only inside the toolbox roots: the user's home folder,
or the folders listed in `REA_TOOLBOX_ROOTS` (colon-separated absolute
paths). Every path is resolved through symbolic links before access, and a
path that doesn't exist yet resolves through its nearest existing ancestor,
so a symlink can't lead outside. When REA runs in the workbench's container,
the container sees only the home folder in any case, and `run_command` uses
the container's tools: besides REA's providers, the image carries npm, Rust
(`cargo`) and gcc-c++/make so projects can be installed and built through
REA.

`write_file` and `edit_file` change files, and `run_command` can run anything
the current user can, including programs that change files or use the
network. Their effects are declared in the tool catalog
(`run_command` is marked destructive), so clients can ask before calling them.

## Built-in tools and their REA equivalents

| Agent built-in                                               | What it does                                             | REA tool                                                                                                                                                                          | State                                            |
| ------------------------------------------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Bash                                                         | Run a shell command                                      | `run_command`                                                                                                                                                                     | Available                                        |
| Read                                                         | Read a file                                              | `read_file`                                                                                                                                                                       | Available                                        |
| Write                                                        | Write a whole file                                       | `write_file`                                                                                                                                                                      | Available                                        |
| Edit                                                         | Replace exact text in a file                             | `edit_file`                                                                                                                                                                       | Available                                        |
| Glob                                                         | Find files by pattern                                    | `find_files`                                                                                                                                                                      | Available                                        |
| Grep                                                         | Search file contents                                     | `search_text`                                                                                                                                                                     | Available                                        |
| —                                                            | Survey a folder: structure, file types, applicable tools | `survey_project_directory`                                                                                                                                                        | Available                                        |
| WebFetch                                                     | Fetch a web page                                         | `fetch_url`                                                                                                                                                                       | Planned                                          |
| WebSearch                                                    | Search the web                                           | `web_search`                                                                                                                                                                      | Planned; needs a search provider the user brings |
| NotebookEdit                                                 | Edit Jupyter notebook cells                              | `edit_notebook`                                                                                                                                                                   | Planned                                          |
| LSP                                                          | Symbols, references, definitions                         | Source-graph tools from the CodeGraph provider                                                                                                                                    | Planned                                          |
| Monitor, background Bash, TaskStop                           | Long-running processes (dev servers, watchers)           | `start_process`, `process_status`, `stop_process`                                                                                                                                 | Planned                                          |
| Browser automation (navigate, click, type, read, screenshot) | Operate a web page                                       | `start_browser_session`, `browser_session_status`, `close_browser_session`, `capture_web_screenshot`, `inspect_web_page`, `capture_browser_scenario`; interactive actions planned | Partly available                                 |

## Not toolbox tools

Some built-ins steer the agent itself rather than act on the system: asking
the user a question, loading tool definitions or skills, starting
sub-agents, scheduling a later turn, plan mode, worktrees, notifications.
They stay with the agent. The workbench records them as part of the
conversation, so they still appear in the audit trail.

## Running agents on the toolbox alone

Claude Code's `--tools ""` turns off its built-in tools while keeping MCP
servers, so an agent started that way can act only through REA. The
workbench will offer this once the planned tools cover what agents need.
