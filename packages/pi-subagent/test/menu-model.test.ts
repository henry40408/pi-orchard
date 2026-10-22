import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BackgroundTask } from "../src/background.ts";
import { MenuModel } from "../src/menu-model.ts";

function task(id: string, status: BackgroundTask["status"] = "running"): BackgroundTask {
  return { id, summary: `summary ${id}`, task: `task ${id}`, status, startedAt: 0 };
}

function modelOf(...tasks: BackgroundTask[]) {
  return new MenuModel(() => tasks);
}

describe("MenuModel", () => {
  it("moves the cursor and wraps", () => {
    const model = modelOf(task("bg-1"));
    model.press("up");
    assert.equal(model.cursor, 2);
    model.press("down");
    assert.equal(model.cursor, 0);
  });

  it("closes on escape", () => {
    assert.deepEqual(modelOf(task("bg-1")).press("escape"), []);
  });

  it("opens the detail on enter and leaves it with any key", () => {
    const model = modelOf(task("bg-1"));
    assert.equal(model.press("enter"), undefined);
    assert.equal(model.mode.kind, "detail");
    assert.equal(model.press("other"), undefined);
    assert.equal(model.mode.kind, "browse");
  });

  it("runs the command of an action row", () => {
    const model = modelOf(task("bg-1"));
    model.press("down");
    assert.deepEqual(model.press("enter"), ["status"]);
  });

  it("cancels only after the person confirms with y", () => {
    const model = modelOf(task("bg-1"));
    assert.equal(model.press("cancel"), undefined);
    assert.deepEqual(model.mode, { kind: "confirm", target: "bg-1" });
    assert.deepEqual(model.press("yes"), ["cancel bg-1"]);
  });

  it("treats every other key as no, including enter and escape", () => {
    for (const key of ["enter", "escape", "other", "up", "cancel"] as const) {
      const model = modelOf(task("bg-1"));
      model.press("cancel");
      assert.equal(model.press(key), undefined, key);
      assert.equal(model.mode.kind, "browse", key);
    }
  });

  it("asks before it cancels all, and ignores the key with nothing running", () => {
    const model = modelOf(task("bg-1"), task("bg-2"));
    model.press("cancelAll");
    assert.equal(model.mode.kind, "confirm");
    assert.deepEqual(model.press("yes"), ["cancel all"]);

    const empty = modelOf();
    empty.press("cancelAll");
    assert.equal(empty.mode.kind, "browse");
  });

  it("ignores the cancel key on an action row", () => {
    const model = modelOf(task("bg-1"));
    model.press("down");
    model.press("cancel");
    assert.equal(model.mode.kind, "browse");
  });

  it("lists the running tasks, then the actions", () => {
    const rows = modelOf(task("bg-1"), task("bg-2", "done"), task("bg-3")).rows;
    assert.deepEqual(
      rows.map((row) => (row.kind === "task" ? row.task.id : row.args)),
      ["bg-1", "bg-3", "status", "history"],
    );
  });

  it("follows the registry: a task that ended leaves the list and the cursor stays inside it", () => {
    const tasks = [task("bg-1"), task("bg-2")];
    const model = new MenuModel(() => tasks);
    model.press("down");
    model.press("down");
    assert.equal(model.cursor, 2);
    tasks[1]!.status = "done";
    tasks[0]!.status = "done";
    model.press("other");
    assert.equal(model.cursor, 1);
    assert.equal(model.runningCount, 0);
  });

  it("drops a confirmed cancel when the task ended while the question was open", () => {
    const tasks = [task("bg-1")];
    const model = new MenuModel(() => tasks);
    model.press("cancel");
    tasks[0]!.status = "done";
    assert.equal(model.press("yes"), undefined);
    assert.equal(model.mode.kind, "browse");
  });
});
