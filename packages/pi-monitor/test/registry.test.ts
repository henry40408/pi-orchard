import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MonitorRegistry } from "../src/registry.ts";

function request(description = "watch", kill: () => void = () => {}) {
  return { description, command: "tail -f log", kill };
}

describe("MonitorRegistry", () => {
  it("gives running monitors ids in order and a one-line description", () => {
    const registry = new MonitorRegistry({ maxRunning: 4 });
    const first = registry.start(request("a\n  b"));
    const second = registry.start(request("x".repeat(200)));
    assert.ok("task" in first && "task" in second);
    assert.equal(first.task.id, "mon-1");
    assert.equal(first.task.description, "a b");
    assert.equal(second.task.id, "mon-2");
    assert.equal(second.task.description.length, 80);
  });

  it("refuses above the limit and accepts again after one ends", () => {
    const registry = new MonitorRegistry({ maxRunning: 1 });
    registry.start(request());
    assert.ok("refusal" in registry.start(request()));
    registry.finish("mon-1", "exited");
    assert.ok("task" in registry.start(request()));
  });

  it("cancel kills the process once and rejects a second cancel", () => {
    const registry = new MonitorRegistry({ maxRunning: 4 });
    let kills = 0;
    registry.start(request("w", () => kills++));
    assert.equal(registry.cancel("mon-1"), undefined);
    assert.match(registry.cancel("mon-1") ?? "", /not running/);
    assert.match(registry.cancel("mon-9") ?? "", /no monitor/);
    assert.equal(kills, 1);
  });

  it("the first reason to end wins", () => {
    const registry = new MonitorRegistry({ maxRunning: 4 });
    registry.start(request());
    assert.equal(registry.finish("mon-1", "limited", "too many"), true);
    assert.equal(registry.finish("mon-1", "exited"), false);
    assert.equal(registry.list()[0]!.status, "limited");
    assert.equal(registry.list()[0]!.detail, "too many");
  });

  it("cancelAll kills every running monitor and reports the count to onChange", () => {
    const counts: number[] = [];
    const registry = new MonitorRegistry({ maxRunning: 4, onChange: (count) => counts.push(count) });
    let kills = 0;
    registry.start(request("a", () => kills++));
    registry.start(request("b", () => kills++));
    registry.cancelAll();
    assert.equal(kills, 2);
    assert.deepEqual(counts, [1, 2, 0]);
  });

  it("a kill that throws does not stop the others", () => {
    const registry = new MonitorRegistry({ maxRunning: 4 });
    let kills = 0;
    registry.start(request("a", () => { throw new Error("gone"); }));
    registry.start(request("b", () => kills++));
    registry.cancelAll();
    assert.equal(kills, 1);
  });

  it("keeps only the newest finished monitors", () => {
    const registry = new MonitorRegistry({ maxRunning: 4, keptFinished: 2 });
    for (let index = 1; index <= 3; index++) {
      registry.start(request());
      registry.finish(`mon-${index}`, "exited");
    }
    assert.deepEqual(registry.list().map((task) => task.id), ["mon-2", "mon-3"]);
  });
});
