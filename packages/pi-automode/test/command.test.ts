import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CLASSIFIER_SWITCH, completeArguments, MENU_ITEMS, runCommand } from "../src/command.ts";
import { MODES } from "../src/config/schema.ts";
import { announceStatus, answerQueries, QUERY_CHANNEL, STATUS_CHANNEL, type StatusMessage } from "../src/handshake.ts";
import { DecisionHistory } from "../src/history.ts";
import { DecisionLog } from "../src/log.ts";
import { AutomodeState } from "../src/state.ts";

function setup(userConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-command-"));
  mkdirSync(join(root, "agent"));
  if (userConfig !== undefined) writeFileSync(join(root, "agent", "automode.json"), userConfig);
  const state = new AutomodeState(join(root, "agent"));
  const history = new DecisionHistory();
  const run = (args: string) => runCommand({ args, cwd: root, state, history });
  return { state, history, cwd: root, run };
}

describe("/automode status, mode and reload", () => {
  it("shows the status without arguments", async () => {
    const { run } = setup();
    const result = await run("");
    assert.equal(result.type, "info");
    assert.match(result.message, /mode: auto/);
    assert.match(result.message, /classifier: on/);
  });

  it("switches the mode", async () => {
    const { state, cwd, run } = setup();
    assert.equal((await run("mode rules")).type, "info");
    assert.equal(state.status(cwd).mode, "rules");
    assert.equal((await run("mode off")).type, "warning");
  });

  it("does not take a bare mode name", async () => {
    const { state, cwd, run } = setup();
    assert.equal((await run("off")).type, "error");
    assert.equal(state.status(cwd).mode, "auto");
  });

  it("rejects an unknown mode and an unknown subcommand", async () => {
    const { state, cwd, run } = setup();
    assert.equal((await run("mode yolo")).type, "error");
    const unknown = await run("yolo");
    assert.equal(unknown.type, "error");
    assert.match(unknown.message, /check <tool> <input>/);
    assert.equal(state.status(cwd).mode, "auto");
  });

  it("refuses to change anything while the config is invalid, and reports the error", async () => {
    const { state, cwd, run } = setup("{ nope");
    assert.equal((await run("mode off")).type, "error");
    assert.equal((await run("allow read")).type, "error");
    assert.equal((await run("classifier off")).type, "error");
    assert.equal((await run("status")).type, "error");
    assert.equal(state.status(cwd).mode, "ask");
  });

  it("reload picks up a fixed file", async () => {
    const { state, cwd, run } = setup("{ nope");
    writeFileSync(join(cwd, "agent", "automode.json"), '{"mode":"rules"}');
    assert.equal((await run("reload")).type, "info");
    assert.equal(state.status(cwd).mode, "rules");
  });
});

describe("/automode status and the log", () => {
  it("shows the log file only while the log is on, and warns about a write failure", async () => {
    const off = setup();
    const log = new DecisionLog(join(off.cwd, "x.jsonl"));
    const run = (args: string, state: AutomodeState) => runCommand({ args, cwd: off.cwd, state, history: off.history, log });
    assert.doesNotMatch((await run("status", off.state)).message, /log:/);

    const on = setup('{"log":{"enabled":true}}');
    const shown = await runCommand({ args: "status", cwd: on.cwd, state: on.state, history: on.history, log });
    assert.match(shown.message, /log: .*x\.jsonl/);
    assert.equal(shown.type, "info");

    log.failure = "disk full";
    const failed = await runCommand({ args: "status", cwd: on.cwd, state: on.state, history: on.history, log });
    assert.match(failed.message, /log write failed: disk full/);
    assert.equal(failed.type, "warning");
  });
});

describe("/automode why", () => {
  it("says so when nothing was decided", async () => {
    const { run } = setup();
    assert.match((await run("why")).message, /No tool call/);
  });

  it("lists the recent decisions, limited by the count", async () => {
    const { history, run } = setup();
    const outcome = { action: "ask", source: "mode", reason: "automode is set to ask" } as const;
    history.record({ toolName: "bash", input: { command: "make" }, outcome, answer: "denied" });
    history.record({ toolName: "read", input: { path: "a.txt" }, outcome: { ...outcome, action: "allow", source: "shortcut" } });

    const all = (await run("why")).message;
    assert.match(all, /bash \{"command":"make"\}/);
    assert.match(all, /ask \(mode, user: denied\)/);
    assert.match(all, /allow \(shortcut\)/);

    const last = (await run("why 1")).message;
    assert.doesNotMatch(last, /bash/);
    assert.match(last, /read/);
  });

  describe("with a log", () => {
    const logged = [{ time: new Date(), toolName: "bash", summary: "{}", outcome: { action: "allow", source: "rule", reason: "ok" }, child: true }] as const;
    const memory = { toolName: "read", input: {}, outcome: { action: "allow", source: "shortcut", reason: "memory" } } as const;

    it("reads the log, and marks a child", async () => {
      const { state, history, cwd } = setup('{"log":{"enabled":true}}');
      history.record(memory);
      const log = new DecisionLog(join(cwd, "a.jsonl"));
      const result = await runCommand({ args: "why", cwd, state, history, log, loggedDecisions: () => [...logged] });
      assert.match(result.message, /\[child\] bash/);
      assert.doesNotMatch(result.message, /memory/);
    });

    it("reads the memory when the log is off", async () => {
      const { state, history, cwd } = setup('{"log":{"enabled":false}}');
      history.record(memory);
      const log = new DecisionLog(join(cwd, "a.jsonl"));
      const result = await runCommand({ args: "why", cwd, state, history, log, loggedDecisions: () => [...logged] });
      assert.match(result.message, /memory/);
    });

    it("reads the memory when the log cannot be written", async () => {
      const { state, history, cwd } = setup('{"log":{"enabled":true}}');
      history.record(memory);
      const log = new DecisionLog(join(cwd, "a.jsonl"));
      log.failure = "disk full";
      const result = await runCommand({ args: "why", cwd, state, history, log, loggedDecisions: () => [...logged] });
      assert.match(result.message, /memory/);
    });
  });

  it("keeps only the newest records and cuts a long input", () => {
    const history = new DecisionHistory(2);
    const outcome = { action: "allow", source: "off", reason: "r" } as const;
    for (const name of ["a", "b", "c"]) history.record({ toolName: name, input: "x".repeat(200), outcome });
    const records = history.recent(10);
    assert.deepEqual(records.map((record) => record.toolName), ["b", "c"]);
    assert.ok((records[0]?.summary.length ?? 0) <= 80);
  });

  it("does not throw on an input that cannot be turned into JSON", () => {
    const history = new DecisionHistory();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const outcome = { action: "allow", source: "off", reason: "r" } as const;
    assert.doesNotThrow(() => history.record({ toolName: "x", input: circular, outcome }));
  });

  it("rejects a count that is not a positive number", async () => {
    const { run } = setup();
    assert.equal((await run("why 0")).type, "error");
    assert.equal((await run("why many")).type, "error");
  });
});

describe("/automode check", () => {
  it("reports the rule that decides a bash command", async () => {
    const { run } = setup('{"permissions":{"deny":["bash(rm:*)"],"allow":["bash(make:*)"]}}');
    assert.match((await run("check bash rm -rf build")).message, /^block \(deny\)/);
    assert.match((await run("check bash make test")).message, /^allow \(rule\)/);
  });

  it("treats the input of a path tool as the path", async () => {
    const { run } = setup('{"allowInsideWorkingDirectory":true,"permissions":{"deny":["read(**/.env)"]}}');
    assert.match((await run("check read .env")).message, /^block \(deny\)/);
    assert.match((await run("check read notes.txt")).message, /^allow \(shortcut\)/);
  });

  it("accepts JSON input", async () => {
    const { run } = setup('{"permissions":{"deny":["bash(rm:*)"]}}');
    assert.match((await run('check bash {"command":"rm x"}')).message, /^block \(deny\)/);
  });

  it("does not run the classifier", async () => {
    const { run } = setup();
    const result = await run("check bash make");
    assert.match(result.message, /^undecided: .*classifier would judge it/);
  });

  it("reports a problem with the input", async () => {
    const { run } = setup();
    assert.equal((await run("check")).type, "error");
    assert.equal((await run("check bash")).type, "error");
    assert.equal((await run("check bash {nope")).type, "error");
    assert.equal((await run("check webfetch https://example.com")).type, "error");
  });

  it("follows the session rules and the mode", async () => {
    const { run } = setup();
    await run("deny bash(make:*)");
    assert.match((await run("check bash make")).message, /^block \(deny\)/);
    await run("mode off");
    assert.match((await run("check bash make")).message, /^allow \(off\)/);
  });
});

describe("/automode allow, ask, deny and rules", () => {
  it("adds a session rule that takes effect and is listed as a session rule", async () => {
    const { state, cwd, run } = setup('{"permissions":{"allow":["read"]}}');
    assert.equal((await run("allow bash(make:*)")).type, "info");
    assert.deepEqual(state.config(cwd).permissions.allow, ["read", "bash(make:*)"]);
    assert.equal((await run("rules")).message, "allow: read\nallow: bash(make:*) (session)");
  });

  it("warns about a rule without a specifier", async () => {
    const { run } = setup();
    const result = await run("allow bash");
    assert.equal(result.type, "warning");
    assert.match(result.message, /no specifier.*every bash call/);
  });

  it("lists deny first, then ask, then allow", async () => {
    const { run } = setup();
    await run("allow a");
    await run("ask b");
    await run("deny c");
    assert.equal((await run("rules")).message, "deny: c (session)\nask: b (session)\nallow: a (session)");
  });

  it("says so when there are no rules", async () => {
    const { run } = setup();
    assert.equal((await run("rules")).message, "No permission rules");
  });

  it("adds a rule only once", async () => {
    const { state, cwd, run } = setup();
    await run("allow read");
    await run("allow read");
    assert.deepEqual(state.config(cwd).permissions.allow, ["read"]);
  });

  it("rejects a malformed rule and a missing rule", async () => {
    const { state, cwd, run } = setup();
    assert.equal((await run("allow")).type, "error");
    assert.equal((await run("allow (nope)")).type, "error");
    assert.deepEqual(state.config(cwd).permissions.allow, []);
  });

  it("drops the session rules on reload", async () => {
    const { state, cwd, run } = setup();
    await run("allow read");
    await run("reload");
    assert.deepEqual(state.config(cwd).permissions.allow, []);
  });

  it("keeps session deny and ask rules, but not allow rules, in a directory with an invalid config", async () => {
    const { state, run } = setup();
    await run("allow read");
    await run("ask write");
    await run("deny bash(curl:*)");
    const broken = mkdtempSync(join(tmpdir(), "automode-broken-"));
    mkdirSync(join(broken, ".pi"));
    writeFileSync(join(broken, ".pi", "automode.json"), "{ nope");

    const { permissions } = state.config(broken);
    assert.deepEqual(permissions.allow, []);
    assert.deepEqual(permissions.ask, ["write"]);
    assert.deepEqual(permissions.deny, ["bash(curl:*)"]);
    assert.equal(
      state.rulesInEffect(broken).map(({ kind, rule }) => `${kind}: ${rule}`).join("\n"),
      "deny: bash(curl:*)\nask: write",
    );
  });

  it("cannot loosen a child below its parent mode", async () => {
    const root = mkdtempSync(join(tmpdir(), "automode-child-"));
    const state = new AutomodeState(root, "ask");
    const history = new DecisionHistory();
    await runCommand({ args: "allow bash", cwd: root, state, history });
    await runCommand({ args: "classifier on", cwd: root, state, history });
    const result = await runCommand({ args: "check bash make", cwd: root, state, history });
    assert.match(result.message, /^ask \(mode\)/);
  });
});

describe("/automode classifier", () => {
  it("switches the classifier off and on for the session", async () => {
    const { state, cwd, run } = setup();
    await run("classifier off");
    assert.equal(state.config(cwd).classifier.enabled, false);
    await run("classifier on");
    assert.equal(state.config(cwd).classifier.enabled, true);
  });

  it("sets the model and goes back to the configured one", async () => {
    const { state, cwd, run } = setup('{"classifier":{"model":"anthropic/configured"}}');
    assert.equal((await run("classifier model openai/gpt")).type, "info");
    assert.equal(state.config(cwd).classifier.model, "openai/gpt");
    await run("classifier model default");
    assert.equal(state.config(cwd).classifier.model, "anthropic/configured");
  });

  it("rejects a model that is not provider/id and a missing option", async () => {
    const { state, cwd, run } = setup();
    assert.equal((await run("classifier model gpt")).type, "error");
    assert.equal((await run("classifier model")).type, "error");
    assert.equal((await run("classifier maybe")).type, "error");
    assert.equal(state.config(cwd).classifier.model, undefined);
  });

  it("keeps the override across a change of directory but not across a reload", async () => {
    const { state, cwd, run } = setup();
    await run("classifier off");
    const other = mkdtempSync(join(tmpdir(), "automode-other-"));
    assert.equal(state.config(other).classifier.enabled, false);
    await run("reload");
    assert.equal(state.config(cwd).classifier.enabled, true);
  });
});

describe("completions and menu", () => {
  const values = (text: string) => completeArguments(text).map((item) => item.value);

  it("offers the subcommands for the first word", () => {
    assert.ok(values("").includes("check"));
    assert.deepEqual(values("cl"), ["classifier"]);
  });

  it("offers modes after mode, with the whole argument text as the value", () => {
    assert.deepEqual(values("mode "), ["mode auto", "mode rules", "mode ask", "mode off"]);
    assert.deepEqual(values("mode r"), ["mode rules"]);
  });

  it("offers classifier options", () => {
    assert.deepEqual(values("classifier o"), ["classifier on", "classifier off"]);
  });

  it("offers nothing where a free text goes", () => {
    assert.deepEqual(values("allow "), []);
  });

  it("builds a menu in which every item is a valid command", async () => {
    const { run } = setup();
    for (const item of MENU_ITEMS) {
      assert.notEqual((await run(item.args)).type, "error", item.label);
    }
  });

  it("builds toggle rows whose every value is a valid command", async () => {
    const { run } = setup();
    for (const mode of MODES) assert.notEqual((await run(`mode ${mode}`)).type, "error", mode);
    for (const option of CLASSIFIER_SWITCH) assert.notEqual((await run(`classifier ${option}`)).type, "error", option);
  });
});

describe("handshake", () => {
  function fakeBus() {
    const handlers = new Map<string, Array<(data: unknown) => void>>();
    const emitted: Array<[string, unknown]> = [];
    return {
      emitted,
      emit(channel: string, data: unknown) {
        emitted.push([channel, data]);
        for (const handler of handlers.get(channel) ?? []) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void) {
        handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
        return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
      },
    };
  }

  it("announces the status", () => {
    const bus = fakeBus();
    const message: StatusMessage = { mode: "auto", active: true, entry: "/x/index.ts" };
    announceStatus(bus, message);
    assert.deepEqual(bus.emitted, [[STATUS_CHANNEL, message]]);
  });

  it("answers a query with the current status", () => {
    const bus = fakeBus();
    const status: StatusMessage = { mode: "rules", active: true, entry: "/x/index.ts" };
    answerQueries(bus, () => status);
    bus.emit(QUERY_CHANNEL, undefined);
    assert.deepEqual(bus.emitted.at(-1), [STATUS_CHANNEL, status]);
  });
});
