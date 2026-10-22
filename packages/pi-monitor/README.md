# pi-monitor

Gives the [pi coding agent](../../README.md) a `monitor` tool: run a long-lived shell command in the background and wake the model with each batch of its output lines. The model waits for an event (a log line, a build result) without polling.

## Install

See the [repository README](../../README.md#install). The footer shows `👁️ idle` or `👁️ N watching`.

## Tools

| Tool | Use |
| --- | --- |
| `monitor` | Start a command. Parameters below. |
| `monitor_list` | List the monitors of this session. |
| `monitor_cancel` | Stop a running monitor. |

`monitor` parameters:

- `command` (required): the shell command. It must keep running and print one line per event, for example `tail -f app.log | grep --line-buffered ERROR`.
- `description` (required): what the model watches for. It is shown in lists and in every message.
- `include` / `exclude`: regexes. Only lines that match `include` and do not match `exclude` reach the model.
- `includeStderr`: also send stderr. Default `false`.

The command runs in the project directory with the same shell as pi's `bash` tool (`/bin/bash -c`, else `bash`, else `sh`), in its own process group. A stop sends SIGTERM to the whole group and SIGKILL after 5 seconds. A monitor needs the interactive UI and is refused without it. Control characters (including ESC) are removed from the output, and output without a newline is cut into lines of `maxLineChars`. When the command exits by itself, a background process that it left behind is not killed, as with pi's `bash` tool.

## Delivery

Lines that arrive within `batchMs` become one message, and the message starts a turn. The text is wrapped in a fence with a random nonce, so output cannot pretend to be a message from you or from the harness. Treat it as data.

A monitor ends when:

- the command exits (the model gets the exit code and the last lines),
- it prints more than `maxEventsPerMinute` lines in one minute (it is **stopped**, and the model is told),
- it runs longer than `maxRuntimeMs` (stopped, and the model is told),
- you cancel it (the model gets a short note), or
- the session ends, switches or forks (silently).

## Commands

`/monitor` alone opens a menu of the running monitors. ↑/↓ move, Enter shows the command, `x` cancels the selected one, `X` cancels all, Esc closes. A cancel asks `y/N` first, and only `y` confirms. Without a terminal UI the command prints `status` and `list`.

| Command | |
| --- | --- |
| `list` | The monitors that run now, with their time. |
| `cancel <id\|all>` | Stop one monitor, or all. |
| `history` | The monitors that ended in this session (the last 20), with the reason. |
| `status` | The config and the number running. |

## Config

`<agent dir>/monitor.json`, read on each call. An unknown key or a value out of range stops the monitor from starting.

| Key | Default | Range |
| --- | --- | --- |
| `maxMonitors` | 4 | 1–16 |
| `maxRuntimeMs` | 3600000 | 10000–86400000 |
| `batchMs` | 1000 | 100–60000 |
| `maxLineChars` | 500 | 80–10000 |
| `maxEventsPerMinute` | 120 | 1–6000 |

## With pi-automode

`pi-monitor` does not depend on `pi-automode`. The contract is the tool name `monitor` and the input field `command`: [`pi-automode`](../pi-automode) judges a `monitor` call like a `bash` call. `bash(...)` rules and the bash analysis apply to the command, and a rule named `monitor` covers the tool as a whole. A subagent never loads `pi-monitor`.
