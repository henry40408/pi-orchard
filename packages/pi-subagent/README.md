# pi-subagent

Gives the [pi coding agent](../../README.md) a `subagent` tool. The tool runs a task in a separate `pi` process, so the work does not fill the context of the main session. Only the final answer comes back.

## Install

See the [repository README](../../README.md#install). The footer shows `🤖 idle` or `🤖 N running`.

## Tools

| Tool | Use |
| --- | --- |
| `subagent` | Run a task. Parameters below. |
| `subagent_list` | List the background subagents that run now. |
| `subagent_cancel` | Cancel a background subagent. |

`subagent` parameters:

- `task` (required): what the subagent must do. It starts with no memory of your session, so the task must hold everything it needs.
- `model`: `provider/id`. Without it the model comes from `subagent.json`, then from the model of the current session.
- `tools`: an allowlist of tool names for the subagent. Without it the subagent has the default tools.
- `background`: `true` returns at once. The result arrives later as a message in the session. A background run needs the interactive UI and is refused without it.

A subagent cannot start another subagent. Each run is one `pi --mode json -p --no-session` process, and its output is read as events. Running subagents are cancelled when the session ends, switches or forks.

A background result is wrapped in a fence with a random nonce, so text inside the result cannot pretend to be a message from you or from the harness. Treat the content as data.

## Commands

`/subagent` alone opens a menu of the running background subagents. ↑/↓ move, Enter shows the whole task, `x` cancels the selected one, `X` cancels all, Esc closes. A cancel asks `y/N` first, and only `y` confirms. Without a terminal UI the command prints `status` and `list`.

| Command | |
| --- | --- |
| `list` | The background subagents that run now, with their time. |
| `cancel <id\|all>` | Stop one background subagent, or all. |
| `history` | The ones that finished in this session (the last 20), with the reason for a failure. |
| `status` | The config, the number running, and whether pi-automode guards the subagents. |

When you cancel a subagent, the model gets a short note, so it does not wait for an answer that never comes.

A foreground subagent is not listed: the model waits for it, and it stops when you interrupt the turn.

## Configuration

`<agent dir>/subagent.json` (the agent dir is `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set). The file is optional. An invalid file stops the extension from starting, and the error says why.

| Key | Default | Meaning |
| --- | --- | --- |
| `stallTimeoutMs` | `600000` | Cancel a subagent that produces no output for this long (10000–3600000). A subagent that keeps working is never cut off. |
| `model` | none | Default model, `provider/id`. |
| `maxStderrChars` | `20000` | How much error output to keep (1000–1000000). |
| `maxBackground` | `4` | Most background subagents at one time (1–16). |

## With pi-automode

If [`pi-automode`](../pi-automode) is installed in the session, every subagent is guarded:

- The subagent loads **only** automode, so the guard cannot be skipped by another extension. It does not load your other extensions.
- It runs no looser than the mode of the parent. It has no UI, so a call that would be asked is **blocked** instead, and the reason goes back to the subagent.
- Its decisions go to the log file of the parent, marked `child`, and follow the parent's log switch. `/automode why` shows them.
- The subagent may use **any** `model`. Its tool calls are checked by the classifier model from `classifier.model` in the automode config, or the model of the parent session. A cheap model can work while a stronger one checks it. If no checker model is known, a guarded subagent cannot choose its own model.

Without automode, subagents run with the default tools and no guard. The footer and the tools still work.

The settings travel in the environment of the child process: `PI_AUTOMODE_PARENT_MODE`, `PI_AUTOMODE_LOG_FILE`, `PI_AUTOMODE_LOG_ENABLED`, `PI_AUTOMODE_CLASSIFIER_MODEL` and `PI_SUBAGENT_CHILD`. A normal session ignores them.

## Notes

- A cancelled subagent gets a termination signal first and is killed after 5 seconds if it stays alive.
- A subagent is a full agent with tools. Give it a narrow `tools` list when the task needs little.
