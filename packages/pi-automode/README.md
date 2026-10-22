# pi-automode

A guard for the tool calls of the [pi coding agent](../../README.md). Every call goes through three steps before it runs:

1. **Rules** you write decide the clear cases: allow, ask, or deny.
2. A **classifier** (a model call) judges what the rules leave open. It sees your recent messages and tool results, and your written policy.
3. Anything still unclear goes to **you**, with the reason. With no one to ask (print mode, a subagent), the call is blocked.

A blocked call returns the reason to the model, so it can choose another way.

## Install

See the [repository README](../../README.md#install). The footer shows `🛡️ automode: auto` while the guard is on, and `⚠️ automode: OFF` when it is off.

## Modes

Set `mode` in the config, or change it for one session with `/automode mode <mode>`.

| Mode | Behavior |
| --- | --- |
| `auto` (default) | Rules first; the classifier decides what no rule covers. |
| `rules` | Rules only. A call that no rule allows is asked. The classifier is never called. |
| `ask` | Every call is asked. Deny rules still block. |
| `off` | Nothing is checked, deny rules included. |

The order is fixed. In every mode but `off`, a **deny rule blocks** first. A path that goes through a **symlink** is also blocked; the reason names the real path, so the model can ask again with it. Only an allow rule, or an allow from the classifier, lets a call run without you.

## Configuration

Two files, both optional JSON. A mistake (an unknown key, a bad rule) is reported and the mode falls back to `ask` until you fix it and run `/automode reload`.

- User: `<agent dir>/automode.json`. The agent dir is `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set.
- Project: `<project>/.pi/automode.json`.

**The project file can only tighten.** It comes from a repository that may not be yours, so it may set a stricter mode, add `ask` and `deny` rules, turn the classifier off, and add `softDeny` and `hardDeny` lines. It cannot add `allow` rules, loosen the mode, change the classifier model or its prompt, or touch the log. Ignored fields are listed in a warning.

```jsonc
{
  "mode": "auto",
  "allowInsideWorkingDirectory": false,
  "permissions": {
    "allow": ["bash(npm test)", "bash(git status:*)", "read(~/notes/**)"],
    "ask": ["bash(git push:*)"],
    "deny": ["read(./.env)", "bash(rm -rf:*)"]
  },
  "classifier": {
    "enabled": true,
    "model": "anthropic/claude-sonnet-4-5",
    "reasoningLevel": "low",
    "timeoutMs": 20000,
    "context": { "userTokens": 4000, "toolTokens": 4000 },
    "environment": ["$defaults", "Our staging server is staging.example.com."],
    "allow": ["$defaults"],
    "softDeny": ["$defaults"],
    "hardDeny": ["$defaults"]
  },
  "log": { "enabled": false, "classifierIo": false, "maxFileBytes": 10485760, "keepDays": 14, "keepFiles": 100 }
}
```

### Rules

A rule is `tool` or `tool(specifier)`. Tool names are lower-cased, so `Read(...)` and `read(...)` are the same.

- **`bash(...)`**: `bash(git status)` matches that exact command; `bash(git push:*)` matches `git push` and anything that starts with `git push `. The shell command is parsed, and every command inside `&&`, pipes, `$(...)`, subshells and loops is checked on its own. A deny or ask rule applies if **any** part matches; an allow rule applies only if **every** part is allowed. A command that cannot be fully analyzed (a parse error, a dynamic command name, a function definition, output written to a file) can never be allowed by a specifier rule.
- **Path tools** (`read`, `write`, `edit`, `ls`, `find`, `grep`): the specifier is a glob (`*`, `**`, `?`). `./` and relative paths are relative to the project; `~` is your home directory. Both the path as written and its real path are matched.
- **A bare tool name** (`read`, `web_fetch`) matches every call of that tool. Other tools have no specifier matching.

Rules added with `/automode allow|ask|deny` last until `reload` or the end of the session; a relative path in them is fixed to the directory where you added it.

`allowInsideWorkingDirectory` lets path tools run without a question inside the project, except under `.git`, `.pi`, `.vscode` and `.envrc`. Only the user file can turn it on.

> **Known gap:** the `powershell` tool is not covered by rules; it only reaches the classifier or you.

### Classifier

The classifier model is a plain model call, not an agent. It answers `allow`, `ask`, or `deny` with a reason, and a timeout or an unusable reply counts as `ask`.

- `model` is `provider/id`. Unset means the model of the current session. A cheaper or stronger one is often a good choice.
- `environment`, `allow`, `softDeny` and `hardDeny` are plain-language lists that go into the prompt. The marker `"$defaults"` stands for the built-in list; keep it, drop it, or add lines next to it. The built-in lists live in [`src/classifier/defaults.ts`](src/classifier/defaults.ts): `allow` lists routine work to treat as safe, `softDeny` lists actions to ask about, and `hardDeny` lists actions never to allow (credentials, `curl | sh`, tampering with automode itself, mass deletion, reverse shells).
- `context` caps how much conversation (in tokens, roughly four characters each) the classifier sees.

The classifier sends part of your conversation to the model you choose. Pick a provider you already trust with that.

## Commands

`/automode` alone opens a menu: `mode`, `classifier` and `log` switch with ←/→, Enter applies, Esc closes. The same things as arguments:

| Command | |
| --- | --- |
| `status` | Mode, classifier, log file, and any config problem. |
| `mode <auto\|rules\|ask\|off>` | Change the mode for this session. |
| `why [count]` | The latest decisions (default 10), each with its source and reason. |
| `check <tool> <input>` | What the rules say about a call, without running it. |
| `allow\|ask\|deny <rule>` | Add a rule for this session. |
| `rules` | The rules in effect. |
| `classifier on\|off` / `classifier model <provider/id\|default>` | Change the classifier for this session. |
| `log on\|off` | Turn the decision log on or off for this session. |
| `reload` | Read the config files again and drop the changes of this session. |

Session changes never outlive the session; edit the config file to keep one.

## Decision log

Off by default. When on (`log.enabled`, or `/automode log on`), each decision is one JSON line in `<agent dir>/automode-logs/`, one file per session start. The line has the time, tool, whole input, action, source, reason, your answer if you were asked, and `child: true` for a subagent. `classifierIo` also records the classifier's prompt and reply, which contain conversation text. A file past `maxFileBytes` is renamed to `.1`; files older than `keepDays` and beyond `keepFiles` are deleted when a session starts.

`/automode why` reads the log, so it shows earlier starts of the same session and the decisions of subagents. With the log off it falls back to memory (this run only, no subagents) and says so.

## With pi-subagent

[`pi-subagent`](../pi-subagent) finds automode through pi's event bus. A subagent then loads only automode, runs no looser than the parent's mode, shares the parent's log file and log switch, and is checked by the classifier model of the parent. See its README.
