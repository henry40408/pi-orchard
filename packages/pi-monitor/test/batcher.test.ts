import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LineBatcher, type Timers } from "../src/batcher.ts";
import { RateLimiter } from "../src/rate-limiter.ts";

function fakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 0;
  const timers: Timers = {
    set: (callback) => {
      pending.set(++next, callback);
      return next;
    },
    clear: (handle) => pending.delete(handle as number),
  };
  return { timers, fire: () => [...pending.values()].forEach((callback) => callback()), count: () => pending.size };
}

describe("LineBatcher", () => {
  it("sends lines that arrive together as one batch", () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const batcher = new LineBatcher({ batchMs: 1000, timers: clock.timers, onBatch: (lines) => batches.push(lines) });
    batcher.add("a");
    batcher.add("b");
    assert.equal(clock.count(), 1);
    clock.fire();
    assert.deepEqual(batches, [["a", "b"]]);
  });

  it("flush sends now and cancels the timer", () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const batcher = new LineBatcher({ batchMs: 1000, timers: clock.timers, onBatch: (lines) => batches.push(lines) });
    batcher.add("a");
    batcher.flush();
    batcher.flush();
    assert.deepEqual(batches, [["a"]]);
    assert.equal(clock.count(), 0);
  });

  it("discard drops pending lines", () => {
    const clock = fakeTimers();
    const batches: string[][] = [];
    const batcher = new LineBatcher({ batchMs: 1000, timers: clock.timers, onBatch: (lines) => batches.push(lines) });
    batcher.add("a");
    batcher.discard();
    batcher.flush();
    assert.deepEqual(batches, []);
  });
});

describe("RateLimiter", () => {
  it("trips only above the limit inside one minute", () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    assert.equal(limiter.record(), false);
    assert.equal(limiter.record(), false);
    assert.equal(limiter.record(), true);
  });

  it("forgets events older than a minute", () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.record();
    limiter.record();
    now = 60_000;
    assert.equal(limiter.record(), false);
  });
});
