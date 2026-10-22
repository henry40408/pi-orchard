import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackgroundRegistry, type BackgroundOutcome } from "../src/background.ts";
import { completeArguments, formatDuration, runCommand } from "../src/command.ts";
import { DEFAULT_CONFIG, type LoadedSubagentConfig } from "../src/config.ts";
import type { GuardPlan } from "../src/guard.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

function manualChild() {
  let finish!: (outcome: BackgroundOutcome) => void;
  const run = () =>
    new Promise<BackgroundOutcome>((resolve) => {
      finish = resolve;
    });
  return { run, finish: (outcome: BackgroundOutcome) => finish(outcome) };
}

function setup(options: { config?: LoadedSubagentConfig; guard?: GuardPlan } = {}) {
  let clock = 1_000_000;
  const registry = new BackgroundRegistry({ maxRunning: 4, now: () => clock });
  const run = (args: string) =>
    runCommand({
      args,
      registry,
      now: clock,
      config: options.config ?? { config: DEFAULT_CONFIG },
      configFile: "/agent/subagent.json",
      guard: options.guard ?? { kind: "none" },
    });
  const start = (task: string) => {
    const child = manualChild();
    const started = registry.start({ task, run: child.run, onFinish: () => {} });
    assert.ok("task" in started);
    return { child, id: started.task.id };
  };
  return { registry, run, start, advance: (milliseconds: number) => (clock += milliseconds) };
}

describe("formatDuration", () => {
  it("uses the two largest units", () => {
    assert.equal(formatDuration(42_000), "42s");
    assert.equal(formatDuration(185_000), "3m 05s");
    assert.equal(formatDuration(3_720_000), "1h 02m");
    assert.equal(formatDuration(-5), "0s");
  });
});

describe("/subagent list", () => {
  it("says so when nothing runs", () => {
    assert.match(setup().run("list").message, /No background subagent is running/);
  });

  it("lists the running tasks with their time", () => {
    const { run, start, advance } = setup();
    start("write the tests");
    advance(65_000);
    assert.equal(run("list").message, "bg-1  1m 05s  write the tests");
  });

  it("leaves out finished tasks", async () => {
    const { run, start } = setup();
    const { child } = start("a");
    child.finish({ text: "ok" });
    await settle();
    assert.match(run("list").message, /No background subagent is running/);
  });
});

describe("/subagent history", () => {
  it("says so when nothing finished", () => {
    assert.match(setup().run("history").message, /has finished/);
  });

  it("lists finished tasks newest first, with the reason for a failure", async () => {
    const { run, start } = setup();
    start("still running");
    const first = start("first");
    const second = start("second");
    first.child.finish({ text: "ok" });
    second.child.finish({ text: "", error: "The subagent exited with code 1\nmore" });
    await settle();
    const lines = run("history").message.split("\n");
    assert.deepEqual(lines, ["bg-3  failed  0s  second", "    The subagent exited with code 1", "bg-2  done  0s  first"]);
  });
});

describe("/subagent cancel", () => {
  it("cancels one task", () => {
    const { registry, run, start } = setup();
    start("a");
    const result = run("cancel bg-1");
    assert.equal(result.type, "info");
    assert.equal(registry.list()[0]?.status, "cancelled");
  });

  it("cancels all running tasks and counts them", () => {
    const { registry, run, start } = setup();
    start("a");
    start("b");
    assert.equal(run("cancel all").message, "Cancelled 2 background subagents.");
    assert.ok(registry.list().every((task) => task.status === "cancelled"));
  });

  it("reports an unknown id, a missing target and an empty list", () => {
    const { run } = setup();
    assert.equal(run("cancel bg-9").type, "error");
    assert.equal(run("cancel").type, "error");
    assert.match(run("cancel all").message, /No background subagent is running/);
  });
});

describe("/subagent status", () => {
  it("shows the config and a missing automode", () => {
    const result = setup().run("status");
    assert.equal(result.type, "info");
    assert.match(result.message, /maxBackground: 4/);
    assert.match(result.message, /model: \(the model of the session\)/);
    assert.match(result.message, /pi-automode: not installed/);
  });

  it("shows the guard", () => {
    const guard: GuardPlan = { kind: "guarded", entry: "/x", mode: "rules", classifierModel: "a/b" };
    assert.match(setup({ guard }).run("").message, /guards subagents, mode rules, classifier a\/b/);
  });

  it("warns about an invalid config and about an unreadable automode", () => {
    const invalid = setup({ config: { errors: ["bad key"] } }).run("status");
    assert.equal(invalid.type, "warning");
    assert.match(invalid.message, /invalid, so no subagent starts:\nbad key/);
    assert.equal(setup({ guard: { kind: "invalid" } }).run("status").type, "warning");
  });
});

describe("/subagent", () => {
  it("rejects an unknown subcommand and shows the usage", () => {
    const result = setup().run("bogus");
    assert.equal(result.type, "error");
    assert.match(result.message, /cancel <id\|all>/);
  });
});

describe("completeArguments", () => {
  it("completes subcommand names", () => {
    assert.deepEqual(
      completeArguments("c", []).map((item) => item.value),
      ["cancel"],
    );
    assert.equal(completeArguments("", []).length, 4);
  });

  it("completes the running ids and all after cancel", () => {
    assert.deepEqual(
      completeArguments("cancel ", ["bg-1", "bg-2"]).map((item) => item.value),
      ["cancel bg-1", "cancel bg-2", "cancel all"],
    );
    assert.deepEqual(
      completeArguments("cancel bg-2", ["bg-1", "bg-2"]).map((item) => item.value),
      ["cancel bg-2"],
    );
    assert.deepEqual(completeArguments("list ", []), []);
  });
});
