import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { completeArguments, formatDuration, runCommand } from "../src/command.ts";
import { DEFAULT_CONFIG, type LoadedMonitorConfig } from "../src/config.ts";
import { MonitorRegistry } from "../src/registry.ts";

function setup(config: LoadedMonitorConfig = { config: DEFAULT_CONFIG }) {
  let clock = 1_000_000;
  const registry = new MonitorRegistry({ maxRunning: 4, now: () => clock });
  const run = (args: string) => runCommand({ args, registry, now: clock, config, configFile: "/agent/monitor.json" });
  const start = (description: string) => {
    const started = registry.start({ description, command: "tail -f log", kill: () => {} });
    assert.ok("task" in started);
    return started.task.id;
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

describe("/monitor", () => {
  it("lists running monitors with their time, and says so when none run", () => {
    const { run, start, advance } = setup();
    assert.match(run("list").message, /No monitor is running/);
    start("watch the log");
    advance(65_000);
    assert.equal(run("list").message, "mon-1  1m 05s  watch the log");
  });

  it("history shows ended monitors, newest first, with the reason", () => {
    const { run, start, registry } = setup();
    start("a");
    start("b");
    registry.finish("mon-1", "failed", "exit code 2");
    registry.cancel("mon-2");
    const lines = run("history").message.split("\n");
    assert.match(lines[0]!, /^mon-2  cancelled/);
    assert.match(lines[1]!, /^mon-1  failed/);
    assert.equal(lines[2], "    exit code 2");
  });

  it("cancels one monitor, all monitors, and reports mistakes", () => {
    const { run, start, registry } = setup();
    start("a");
    start("b");
    assert.equal(run("cancel mon-1").message, "Cancelled mon-1.");
    assert.equal(run("cancel mon-1").type, "error");
    assert.equal(run("cancel").type, "error");
    assert.equal(run("cancel all").message, "Cancelled 1 monitor.");
    assert.equal(run("cancel all").message, "No monitor is running.");
    assert.equal(registry.list().every((task) => task.status === "cancelled"), true);
  });

  it("status shows the config, or the errors of an invalid one", () => {
    assert.match(setup().run("status").message, /maxEventsPerMinute: 120/);
    const broken = setup({ errors: ["/agent/monitor.json: /batchMs must be >= 100"] }).run("");
    assert.equal(broken.type, "warning");
    assert.match(broken.message, /batchMs/);
  });

  it("rejects an unknown subcommand", () => {
    const result = setup().run("frobnicate");
    assert.equal(result.type, "error");
    assert.match(result.message, /cancel <id\|all>/);
  });
});

describe("completeArguments", () => {
  it("completes subcommands and the ids to cancel", () => {
    assert.deepEqual(completeArguments("ca", []).map((completion) => completion.value), ["cancel"]);
    assert.deepEqual(completeArguments("cancel m", ["mon-1", "mon-2"]).map((completion) => completion.value), ["cancel mon-1", "cancel mon-2"]);
    assert.deepEqual(completeArguments("cancel mon-1 x", ["mon-1"]), []);
    assert.deepEqual(completeArguments("list x", []), []);
  });
});
