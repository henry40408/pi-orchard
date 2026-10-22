import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QUERY_CHANNEL, queryGuard, STATUS_CHANNEL } from "../src/guard.ts";

/** Behaves like pi's bus: handlers run during `emit`. `reply` plays pi-automode. */
function busWithAutomode(reply: (() => unknown[]) | undefined) {
  const handlers = new Map<string, Array<(data: unknown) => void>>();
  const bus = {
    emit(channel: string, data: unknown) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void) {
      handlers.set(channel, [...(handlers.get(channel) ?? []), handler]);
      return () => handlers.set(channel, (handlers.get(channel) ?? []).filter((candidate) => candidate !== handler));
    },
    listenerCount: (channel: string) => handlers.get(channel)?.length ?? 0,
  };
  if (reply) bus.on(QUERY_CHANNEL, () => reply().forEach((message) => bus.emit(STATUS_CHANNEL, message)));
  return bus;
}

describe("queryGuard", () => {
  it("reports none when pi-automode does not answer", () => {
    assert.deepEqual(queryGuard(busWithAutomode(undefined)), { kind: "none" });
  });

  it("passes on the log file when the answer has one", () => {
    const bus = busWithAutomode(() => [{ mode: "auto", active: true, entry: "/a/index.ts", logFile: "/l/a.jsonl" }]);
    assert.deepEqual(queryGuard(bus), { kind: "guarded", entry: "/a/index.ts", mode: "auto", logFile: "/l/a.jsonl" });
  });

  it("returns the mode and entry of a good answer", () => {
    const bus = busWithAutomode(() => [{ mode: "rules", active: true, entry: "/a/index.ts" }]);
    assert.deepEqual(queryGuard(bus), { kind: "guarded", entry: "/a/index.ts", mode: "rules" });
  });

  it("uses the last answer", () => {
    const bus = busWithAutomode(() => [
      { mode: "auto", active: true, entry: "/a/index.ts" },
      { mode: "ask", active: true, entry: "/a/index.ts" },
    ]);
    assert.deepEqual(queryGuard(bus), { kind: "guarded", entry: "/a/index.ts", mode: "ask" });
  });

  it("rejects an answer it cannot read, so no child runs unguarded", () => {
    for (const reply of [null, "auto", {}, { mode: "yolo", entry: "/a" }, { mode: "auto" }, { mode: "auto", entry: "" }]) {
      assert.deepEqual(queryGuard(busWithAutomode(() => [reply])), { kind: "invalid" }, JSON.stringify(reply));
    }
  });

  it("stops listening afterwards", () => {
    const bus = busWithAutomode(() => [{ mode: "auto", active: true, entry: "/a" }]);
    queryGuard(bus);
    assert.equal(bus.listenerCount(STATUS_CHANNEL), 0);
  });
});
