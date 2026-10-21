import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runCommand } from "../src/command.ts";
import { announceStatus, answerQueries, QUERY_CHANNEL, STATUS_CHANNEL } from "../src/handshake.ts";
import { AutomodeState, type AutomodeStatus } from "../src/state.ts";

function setup(userConfig?: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-command-"));
  mkdirSync(join(root, "agent"));
  if (userConfig !== undefined) writeFileSync(join(root, "agent", "automode.json"), userConfig);
  return { state: new AutomodeState(join(root, "agent")), cwd: root };
}

describe("/automode", () => {
  it("shows the status without arguments", () => {
    const { state, cwd } = setup();
    const result = runCommand("", state, cwd);
    assert.equal(result.type, "info");
    assert.match(result.message, /mode: auto/);
  });

  it("switches the mode", () => {
    const { state, cwd } = setup();
    assert.equal(runCommand("rules", state, cwd).type, "info");
    assert.equal(state.status(cwd).mode, "rules");
    assert.equal(runCommand("off", state, cwd).type, "warning");
  });

  it("rejects an unknown argument", () => {
    const { state, cwd } = setup();
    assert.equal(runCommand("yolo", state, cwd).type, "error");
    assert.equal(state.status(cwd).mode, "auto");
  });

  it("refuses to switch while the config is invalid, and reports the error", () => {
    const { state, cwd } = setup("{ nope");
    assert.equal(runCommand("off", state, cwd).type, "error");
    assert.equal(runCommand("status", state, cwd).type, "error");
    assert.equal(state.status(cwd).mode, "ask");
  });

  it("reload picks up a fixed file", () => {
    const { state, cwd } = setup("{ nope");
    writeFileSync(join(cwd, "agent", "automode.json"), '{"mode":"rules"}');
    assert.equal(runCommand("reload", state, cwd).type, "info");
    assert.equal(state.status(cwd).mode, "rules");
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
    announceStatus(bus, { mode: "auto", active: true });
    assert.deepEqual(bus.emitted, [[STATUS_CHANNEL, { mode: "auto", active: true }]]);
  });

  it("answers a query with the current status", () => {
    const bus = fakeBus();
    const status: AutomodeStatus = { mode: "rules", active: true };
    answerQueries(bus, () => status);
    bus.emit(QUERY_CHANNEL, undefined);
    assert.deepEqual(bus.emitted.at(-1), [STATUS_CHANNEL, status]);
  });
});
