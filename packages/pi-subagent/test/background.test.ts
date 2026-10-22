import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BackgroundRegistry, type BackgroundOutcome, type BackgroundTask } from "../src/background.ts";

/** A child that ends when the test says so. */
function manualChild() {
  let finish!: (outcome: BackgroundOutcome) => void;
  let signal!: AbortSignal;
  const run = (given: AbortSignal) => {
    signal = given;
    return new Promise<BackgroundOutcome>((resolve) => {
      finish = resolve;
    });
  };
  return { run, finish: (outcome: BackgroundOutcome) => finish(outcome), signal: () => signal };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

function started(registry: BackgroundRegistry, child = manualChild(), finished: BackgroundTask[] = []) {
  const result = registry.start({ task: "do it", run: child.run, onFinish: (task) => finished.push(task) });
  assert.ok("task" in result);
  return { child, finished, task: result.task };
}

describe("BackgroundRegistry", () => {
  it("gives running tasks ids in order and a one-line summary", () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const first = registry.start({ task: "a\n  b", run: manualChild().run, onFinish: () => {} });
    const second = registry.start({ task: "x".repeat(200), run: manualChild().run, onFinish: () => {} });
    assert.ok("task" in first && "task" in second);
    assert.equal(first.task.id, "bg-1");
    assert.equal(first.task.summary, "a b");
    assert.equal(second.task.id, "bg-2");
    assert.equal(second.task.summary.length, 80);
  });

  it("keeps the whole task text, and the error of a failed task", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const { child } = started(registry, manualChild());
    assert.equal(registry.list()[0]?.task, "do it");
    child.finish({ text: "", error: "boom" });
    await settle();
    assert.equal(registry.list()[0]?.error, "boom");
  });

  it("refuses a task over the limit, and accepts one again after a task ends", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 1 });
    const { child } = started(registry);
    const refused = registry.start({ task: "more", run: manualChild().run, onFinish: () => {} });
    assert.ok("refusal" in refused);
    assert.match(refused.refusal, /limit is 1/);

    child.finish({ text: "ok" });
    await settle();
    assert.ok("task" in registry.start({ task: "more", run: manualChild().run, onFinish: () => {} }));
  });

  it("uses a new limit at once", () => {
    const registry = new BackgroundRegistry({ maxRunning: 1 });
    started(registry);
    registry.setMaxRunning(2);
    assert.ok("task" in registry.start({ task: "more", run: manualChild().run, onFinish: () => {} }));
  });

  it("reports a finished task as done, with its text", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const { child, finished } = started(registry);
    child.finish({ text: "answer" });
    await settle();
    assert.equal(finished.length, 1);
    assert.equal(finished[0]?.status, "done");
    assert.equal(registry.list()[0]?.status, "done");
    assert.ok(registry.list()[0]?.finishedAt !== undefined);
  });

  it("reports an error outcome and a thrown error as failed", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const failing = started(registry);
    failing.child.finish({ text: "", error: "stalled" });
    const throwing = started(registry, { run: () => Promise.reject(new Error("boom")), finish: () => {}, signal: () => new AbortController().signal });
    await settle();
    assert.equal(failing.finished[0]?.status, "failed");
    assert.equal(throwing.finished[0]?.status, "failed");
  });

  it("aborts a cancelled task and sends no notification for it", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const { child, finished, task } = started(registry);
    assert.equal(registry.cancel(task.id), undefined);
    assert.equal(child.signal().aborted, true);
    child.finish({ text: "late", error: "aborted" });
    await settle();
    assert.deepEqual(finished, []);
    assert.equal(registry.list()[0]?.status, "cancelled");
  });

  it("says why nothing was cancelled", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    assert.match(registry.cancel("bg-9") ?? "", /no background subagent/);
    const { child, task } = started(registry);
    child.finish({ text: "" });
    await settle();
    assert.match(registry.cancel(task.id) ?? "", /not running \(done\)/);
  });

  it("cancels every running task and leaves finished ones alone", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const done = started(registry);
    const one = started(registry);
    const two = started(registry);
    done.child.finish({ text: "" });
    await settle();
    registry.cancelAll();
    assert.deepEqual(registry.list().map((task) => task.status), ["done", "cancelled", "cancelled"]);
    assert.equal(one.child.signal().aborted && two.child.signal().aborted, true);
  });

  it("keeps only the newest finished tasks, and never drops a running one", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 10, keptFinished: 2 });
    const running = started(registry);
    for (let index = 0; index < 3; index += 1) {
      const { child } = started(registry);
      child.finish({ text: "" });
      await settle();
    }
    assert.deepEqual(registry.list().map((task) => task.id), [running.task.id, "bg-3", "bg-4"]);
  });

  it("reports the running count when a task starts, ends, is cancelled, or all are cancelled", async () => {
    const counts: number[] = [];
    const registry = new BackgroundRegistry({ maxRunning: 4, onChange: (count) => counts.push(count) });
    const first = started(registry);
    const second = started(registry);
    const third = started(registry);
    first.child.finish({ text: "" });
    await settle();
    registry.cancel(second.task.id);
    registry.cancelAll();
    assert.deepEqual(counts, [1, 2, 3, 2, 1, 0]);
    assert.equal(third.child.signal().aborted, true);
  });

  it("survives an onChange that throws", () => {
    const registry = new BackgroundRegistry({
      maxRunning: 4,
      onChange: () => {
        throw new Error("no ui");
      },
    });
    started(registry);
    assert.equal(registry.list()[0]?.status, "running");
  });

  it("survives an onFinish that throws", async () => {
    const registry = new BackgroundRegistry({ maxRunning: 4 });
    const child = manualChild();
    registry.start({
      task: "t",
      run: child.run,
      onFinish: () => {
        throw new Error("notify failed");
      },
    });
    child.finish({ text: "" });
    await settle();
    assert.equal(registry.list()[0]?.status, "done");
  });
});
