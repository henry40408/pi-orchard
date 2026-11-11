# CLAUDE.md

Guidance for Claude Code (claude.ai/code) in this repository.

## What this is

An npm workspace with three extensions for the pi coding agent (`@earendil-works/pi-coding-agent`):

- `packages/pi-automode`: checks every tool call (rules, then a classifier model, then the user). Three layers in `src/` (and `test/`): `core/` (no host imports), `pi/` (the pi extension), `durable/` (an extension for `@earendil-works/pi-durable`).
- `packages/pi-subagent`: the `subagent` tool and the `/subagent` command. Works alone; when pi-automode is loaded, the child is guarded.
- `packages/pi-monitor`: the `monitor` tool and the `/monitor` command. Works alone; pi-automode judges a `monitor` call like a `bash` call. Layers in `src/` (and `test/`): `core/` (no host imports), `pi/` (the pi extension), `durable/` (an extension for `@earendil-works/pi-durable`).

## Commands

- Install: `npm ci` (Node version in `.node-version`; Node runs the `.ts` files directly, there is no build step).
- Typecheck (CI gate): `npm run typecheck`.
- Test (CI gate): `npm test`. One file: `node --test packages/pi-automode/test/core/command.test.ts`.
- Release: `gh release create --generate-notes`; never edit the manifest `version` or add a `CHANGELOG.md`.

## Conventions

- Code, comments, error strings and test names are in English.
- Imports use the `.ts` extension. Tests use `node:test` and `node:assert/strict`, one test file per source module, with helpers defined in the test file.
- Logic that can be pure is pure (`command.ts`, `menu-model.ts`) and returns data; `index.ts` and `menu.ts` only wire pi and draw. `index.ts` wiring has no automated test, so a change there needs a manual run in pi.
- Dependencies are pinned in the root `package.json`; the packages declare pi, `pi-tui` and `typebox` as peer dependencies (`^`). Do not use a release that is under 7 days old.
- GitHub Actions are pinned to a commit SHA with the version in a comment.

## Decisions to keep

- Project config (`<cwd>/.pi/automode.json`) can only tighten: it may not add `allow` rules or change the classifier model, the log, or `allowInsideWorkingDirectory`.
- `/automode off` also turns off `deny` rules. This is deliberate.
- Rules cover `bash` and the path tools (`read write edit ls find grep`); `powershell` is not covered.
- A symlink is blocked, and the reason shows the real path.
- A call that needs a question, with no user to ask (print mode, a subagent), is blocked, never allowed.
- The decision log is off by default. `/automode why` falls back to memory and says so.
- A child pi gets its settings from the environment of the parent, and only a child reads them: `PI_AUTOMODE_PARENT_MODE`, `PI_AUTOMODE_LOG_FILE`, `PI_AUTOMODE_LOG_ENABLED`, `PI_AUTOMODE_CLASSIFIER_MODEL`, `PI_SUBAGENT_CHILD`. pi-subagent and pi-automode define the same constants on both sides, so change both together.
- A subagent may use any model; its tool calls are checked by the classifier model of the parent.
- A subagent cancel by the user sends the model a note, because a cancelled task sends no result.
- pi-monitor layers follow the same rule as pi-automode. `core/` takes the process as a `start` function from the host: `pi/` spawns a child, `durable/` runs the command in the `ExecutionEnv` of the Harness (`env.exec`, with its own cancel context, so the command outlives the tool call).
- The durable monitor lives in memory and is not told about a restart of the host; the host sends the output with `deliver`, because a tool call cannot submit input after it ends.
- pi-subagent has no durable entry, by design: a durable subagent is a conversation that a tool owns and it copies the extensions of its owner, so pi-automode guards it with no wiring (`test/durable/subagent.test.ts`). The READMEs say so.
- `monitor` is an alias of `bash` in pi-automode (`SHELL_TOOLS`): same tool name `monitor` and input field `command` on both sides, so change both together. pi-monitor never imports pi-automode.
- A monitor that exceeds `maxEventsPerMinute` is stopped, not throttled, and the model is told. Every batch of output starts a model turn, by design.
- Node's strip-only TypeScript mode is used to run the files: no parameter properties, enums or namespaces.
- pi-automode layers: `core/` never imports pi, `pi-tui` or `pi-durable`; `pi/` and `durable/` import `core/` only, never each other. The judging and the recording of a call live in `core/guard.ts`; an adapter only builds the `GuardCall` and acts on the outcome.
- `pi-durable` is an optional peer dependency and is pinned to a release over 7 days old (1.5.0). In that release a `beforeTool` hook cannot park a call, so the durable adapter blocks an `ask` outcome, as pi does with no UI. When a newer release is over 7 days old, `ask` can sleep on a signal instead.
