import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MenuModel, toggleRow, type MenuKey } from "../src/menu-model.ts";

function menu() {
  return new MenuModel([
    toggleRow("mode", ["auto", "rules", "ask", "off"], "auto"),
    toggleRow("classifier", ["on", "off"], "on"),
    { kind: "action", label: "status", args: "status" },
    { kind: "action", label: "reload", args: "reload" },
  ]);
}

function pressAll(model: MenuModel, keys: MenuKey[]) {
  let result: string[] | undefined;
  for (const key of keys) result = model.press(key);
  return result;
}

describe("MenuModel", () => {
  it("starts on the current value of each toggle, and on 0 for an unknown value", () => {
    const model = new MenuModel([toggleRow("mode", ["auto", "rules"], "rules"), toggleRow("classifier", ["on", "off"], "?")]);
    assert.deepEqual(model.rows.map((row) => row.kind === "toggle" && row.value), [1, 0]);
  });

  it("answers with the status when enter finds no change", () => {
    assert.deepEqual(pressAll(menu(), ["enter"]), ["status"]);
  });

  it("returns one command for each toggle that changed", () => {
    assert.deepEqual(pressAll(menu(), ["right", "down", "right", "enter"]), ["mode rules", "classifier off"]);
  });

  it("goes round at both ends of a toggle", () => {
    assert.deepEqual(pressAll(menu(), ["left", "enter"]), ["mode off"]);
    assert.deepEqual(pressAll(menu(), ["right", "right", "right", "right", "enter"]), ["status"]);
  });

  it("does not return a toggle that was changed and changed back", () => {
    assert.deepEqual(pressAll(menu(), ["right", "left", "enter"]), ["status"]);
  });

  it("goes round at both ends of the rows", () => {
    const model = menu();
    model.press("up");
    assert.equal(model.cursor, 3);
    model.press("down");
    assert.equal(model.cursor, 0);
  });

  it("ignores left and right on an action row", () => {
    assert.deepEqual(pressAll(menu(), ["down", "down", "left", "right", "enter"]), ["status"]);
  });

  it("runs the changed toggles first and then the action under the cursor", () => {
    assert.deepEqual(pressAll(menu(), ["right", "down", "down", "enter"]), ["mode rules", "status"]);
  });

  it("runs reload before the toggles, because reload drops them", () => {
    assert.deepEqual(pressAll(menu(), ["right", "down", "down", "down", "enter"]), ["reload", "mode rules"]);
  });

  it("does not change the rows it was given", () => {
    const row = toggleRow("mode", ["auto", "rules"], "auto");
    new MenuModel([row]).press("right");
    assert.equal(row.value, 0);
  });
});
