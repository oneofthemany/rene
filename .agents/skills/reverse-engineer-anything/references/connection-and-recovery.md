# Connection and task recovery

Read this guide only for an observed command, refusal or provider blocker.
Keep the user's target and question in view. Explain what prevented the
operation and the next useful step; after repair, continue the investigation.

REA is reached as `rene` in your shell (`rene call <tool> '<json>'`), never
as an MCP server. Follow `rene tools describe <tool>` for each tool's current
schema rather than assuming another release exposes the same arguments.

## Choose the remedy from the observed failure

| Observation                                                     | Meaning and next step                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rene` is not found                                             | The session's PATH lacks it. A workbench session gets `rene` on its PATH; outside one, use the checkout's `scripts/rene.mjs` with the pinned Node. Do not register REA over MCP instead.                                                                                                                              |
| `rene` says its compiled runtime is missing or `dist` is older  | The checkout needs `npm run build:cached`. Ask the user before building if that is outside your authorized scope.                                                                                                                                                                                                     |
| `No REA daemon answers at … (REA_DAEMON_SOCKET)`                | The session's daemon has exited. Unset `REA_DAEMON_SOCKET` to run each call in its own session, or start `rene daemon --socket <path>`; targets opened earlier must be opened again.                                                                                                                                  |
| A call is refused before it runs                                | The workbench's gate or the agent's own policy refused it, not REA. Read the refusal: it names the rule and the allowed form (for example run_command's arguments on the line, or a topic declared first). Do not retry the same call unchanged.                                                                      |
| REA returns `provider_unavailable` or an unavailable tool entry | Read that operation's provider diagnostics or `binary_session.result.tool_availability`. Expand each group's tool names and inherit the shared client requirements unless overridden. Use the operation's availability, reason, and remediation; a complete tool catalog does not imply every operation is available. |
| A provider path seems ignored                                   | `rene` applies the workbench's saved provider paths (REA_WORKBENCH_SETTINGS, or the checkout's `frontend/.workbench-settings.json`) for variables the shell doesn't set; a shell value wins. `rea doctor --json` shows what REA sees.                                                                                 |

Static JavaScript and ordinary ZIP inventory need neither Hopper nor Ghidra.
HAR inspection is offline and does not require a live browser. Native
decompilation, Android analysis and firmware extraction have their own
bring-your-own prerequisites. Use supported inventory/static evidence when it
answers part of the question, and name the unavailable evidence separately.
Do not substitute another target. Label observations from ordinary shell tools
as such; only actual REA output supplies REA Evidence.

## Check readiness without changing anything

```bash
rea doctor --json
rene skill status
```

Doctor reports each provider's readiness and remediation. `rene skill status`
shows whether this skill is installed and current; `rene skill install`
refreshes it. Neither installs an analysis engine. Do not install or upgrade
unrelated prerequisites (Node.js, npm, Java, Ghidra, IDA, JADX, Kuna, Binwalk,
Unblob) without the user's approval.

## Keep large results out of context

Within one session (a workbench session's daemon, or `rene daemon`), REA
retains complete Evidence, so ask for a summary first and read views of it:

```bash
rene call analyze_javascript_application '{"input_path":"/absolute/path/to/app","detail":"summary"}'
rene call inspect_analysis_view '{"source":{…the returned same-session Evidence reference…},"view":{"kind":"summary"}}'
rene call export_evidence_bundle '{"path":"/absolute/path/to/evidence-bundle.json"}'
```

`export_evidence_bundle` writes the whole session's Evidence to a file you
chose, without passing it through your context.

Inspect a module page or item the same way, following the
[JavaScript recipes](javascript-applications.md). Preserve graph coverage,
limitations and unknowns. Native analysis still requires its selected engine,
and every call keeps the host's execution permissions.
