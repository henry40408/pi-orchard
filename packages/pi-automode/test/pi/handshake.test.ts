import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { announceStatus, answerQueries, QUERY_CHANNEL, STATUS_CHANNEL, type StatusMessage } from "../../src/pi/handshake.ts";

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
