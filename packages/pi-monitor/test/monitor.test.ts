import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Timers } from "../src/batcher.ts";
import { DEFAULT_CONFIG, type MonitorConfig } from "../src/config.ts";
import { launchMonitor } from "../src/monitor.ts";
import { MonitorRegistry } from "../src/registry.ts";
import type { MonitorExit, MonitorRunRequest } from "../src/run.ts";

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** A process that prints and ends when the test says so. */
function fakeProcess() {
  let request!: MonitorRunRequest;
  let end!: (exit: MonitorExit) => void;
  const killed: string[] = [];
  const start = (given: MonitorRunRequest) => {
    request = given;
    return {
      kill: () => killed.push("kill"),
      done: new Promise<MonitorExit>((resolve) => {
        end = resolve;
      }),
    };
  };
  return {
    start,
    killed,
    print: (chunk: string, stream: "stdout" | "stderr" = "stdout") => request.onData(stream, chunk),
    exit: (code: number | undefined, extra: Partial<MonitorExit> = {}) => end({ exitCode: code, signal: undefined, startError: undefined, ...extra }),
  };
}

function fakeTimers() {
  const pending = new Map<number, { callback: () => void; ms: number }>();
  let next = 0;
  const timers: Timers = {
    set: (callback, ms) => {
      pending.set(++next, { callback, ms });
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  /** Fires the timers with this delay. */
  const fire = (ms: number) => [...pending.entries()].filter(([, timer]) => timer.ms === ms).forEach(([handle, timer]) => (pending.delete(handle), timer.callback()));
  return { timers, fire };
}

function setup(overrides: Partial<MonitorConfig> = {}, options: { includeStderr?: boolean; filter?: (line: string) => boolean } = {}) {
  const process = fakeProcess();
  const clock = fakeTimers();
  const sent: string[] = [];
  const registry = new MonitorRegistry({ maxRunning: 4 });
  const config = { ...DEFAULT_CONFIG, ...overrides };
  const result = launchMonitor({
    registry,
    command: "tail -f log",
    description: "watch the log",
    cwd: ".",
    shell: { path: "/bin/sh", args: ["-c"] },
    config,
    filter: options.filter ?? (() => true),
    includeStderr: options.includeStderr ?? false,
    send: (text) => sent.push(text),
    start: process.start,
    timers: clock.timers,
    now: () => 0,
  });
  assert.ok("task" in result);
  return { process, clock, sent, registry, config, id: result.task.id };
}

describe("launchMonitor", () => {
  it("sends lines that arrive together as one message", () => {
    const { process, clock, sent, config } = setup();
    process.print("one\ntwo\nthr");
    process.print("ee\n");
    clock.fire(config.batchMs);
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /printed 3 line\(s\)/);
    assert.ok(sent[0]!.includes("one\ntwo\nthree"));
  });

  it("ignores stderr unless asked, and applies the filter", () => {
    const quiet = setup({}, { filter: (line) => line.startsWith("E") });
    quiet.process.print("Eone\nskip\n");
    quiet.process.print("Estderr\n", "stderr");
    quiet.clock.fire(quiet.config.batchMs);
    assert.ok(quiet.sent[0]!.includes("Eone"));
    assert.ok(!quiet.sent[0]!.includes("skip"));
    assert.ok(!quiet.sent[0]!.includes("Estderr"));

    const loud = setup({}, { includeStderr: true });
    loud.process.print("from stderr\n", "stderr");
    loud.clock.fire(loud.config.batchMs);
    assert.ok(loud.sent[0]!.includes("from stderr"));
  });

  it("cuts a long line", () => {
    const { process, clock, sent, config } = setup({ maxLineChars: 80 });
    process.print(`${"x".repeat(200)}\n`);
    clock.fire(config.batchMs);
    assert.match(sent[0]!, /\[120 more characters\]/);
  });

  it("sends the last batch and then the end when the command exits", async () => {
    const { process, sent, registry, id } = setup();
    process.print("last\n");
    process.exit(0);
    await settle();
    assert.equal(sent.length, 2);
    assert.match(sent[0]!, /printed 1 line/);
    assert.match(sent[1]!, new RegExp(`${id} .* ended: exit code 0`));
    assert.equal(registry.list()[0]!.status, "exited");
  });

  it("reports a failing command", async () => {
    const { process, sent, registry } = setup();
    process.exit(2);
    await settle();
    assert.match(sent[0]!, /failed: exit code 2/);
    assert.equal(registry.list()[0]!.status, "failed");
  });

  it("stops the monitor and tells the model when the rate limit is exceeded", () => {
    const { process, sent, registry, id } = setup({ maxEventsPerMinute: 2 });
    process.print("a\nb\nc\nd\n");
    assert.equal(sent.length, 1);
    assert.match(sent[0]!, /was stopped because it printed too many lines/);
    assert.ok(sent[0]!.includes("a\nb\nc"));
    assert.equal(registry.list()[0]!.status, "limited");
    assert.equal(process.killed.length, 1);
    assert.ok(sent[0]!.includes(id));
  });

  it("stops the monitor when it runs too long", () => {
    const { process, clock, sent, registry, config } = setup();
    clock.fire(config.maxRuntimeMs);
    assert.match(sent[0]!, /ran too long/);
    assert.equal(registry.list()[0]!.status, "timed-out");
    assert.equal(process.killed.length, 1);
  });

  it("sends nothing after the user cancelled", async () => {
    const { process, clock, sent, registry, config, id } = setup();
    process.print("pending\n");
    assert.equal(registry.cancel(id), undefined);
    clock.fire(config.batchMs);
    process.exit(1);
    await settle();
    assert.deepEqual(sent, []);
    assert.equal(registry.list()[0]!.status, "cancelled");
    assert.equal(process.killed.length, 1);
  });

  it("frees the slot and sends nothing when the process cannot be created", () => {
    const registry = new MonitorRegistry({ maxRunning: 1 });
    const clock = fakeTimers();
    const sent: string[] = [];
    const result = launchMonitor({
      registry,
      command: "x",
      description: "x",
      cwd: ".",
      shell: { path: "/bin/sh", args: ["-c"] },
      config: DEFAULT_CONFIG,
      filter: () => true,
      includeStderr: false,
      send: (text) => sent.push(text),
      start: () => {
        throw new Error("bad argument");
      },
      timers: clock.timers,
    });
    assert.ok("refusal" in result && result.refusal.includes("bad argument"));
    assert.equal(registry.list()[0]!.status, "failed");
    clock.fire(DEFAULT_CONFIG.maxRuntimeMs);
    assert.deepEqual(sent, []);
    assert.ok("task" in launchMonitor({ registry, command: "y", description: "y", cwd: ".", shell: { path: "/bin/sh", args: ["-c"] }, config: DEFAULT_CONFIG, filter: () => true, includeStderr: false, send: () => {}, start: fakeProcess().start, timers: fakeTimers().timers }));
  });

  it("removes control characters from the lines it sends", () => {
    const { process, clock, sent, config } = setup();
    process.print("a\u001b[2Jb\n");
    clock.fire(config.batchMs);
    assert.ok(sent[0]!.includes("a[2Jb"));
    assert.ok(!sent[0]!.includes("\u001b"));
  });

  it("refuses when too many monitors run", () => {
    const registry = new MonitorRegistry({ maxRunning: 1 });
    const launch = () =>
      launchMonitor({
        registry,
        command: "x",
        description: "x",
        cwd: ".",
        shell: { path: "/bin/sh", args: ["-c"] },
        config: DEFAULT_CONFIG,
        filter: () => true,
        includeStderr: false,
        send: () => {},
        start: fakeProcess().start,
        timers: fakeTimers().timers,
      });
    assert.ok("task" in launch());
    assert.ok("refusal" in launch());
  });
});
