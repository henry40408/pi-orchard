import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileLineFilter, LineSplitter, stripControlCharacters, truncateLine } from "../src/lines.ts";

describe("stripControlCharacters", () => {
  it("removes ESC and other control characters but keeps tabs", () => {
    assert.equal(stripControlCharacters("a\u001b[31mb\tc\u0000d\u007f"), "a[31mb\tcd");
  });
});

describe("LineSplitter", () => {
  it("joins a line that arrives in pieces and strips CR", () => {
    const splitter = new LineSplitter(100);
    assert.deepEqual(splitter.push("ab"), []);
    assert.deepEqual(splitter.push("c\r\nd\ne"), ["abc", "d"]);
    assert.deepEqual(splitter.flush(), ["e"]);
    assert.deepEqual(splitter.flush(), []);
  });

  it("cuts output without a newline, so the buffer stays small", () => {
    const splitter = new LineSplitter(4);
    assert.deepEqual(splitter.push("abcdefghij"), ["abcd", "efgh"]);
    assert.deepEqual(splitter.flush(), ["ij"]);
  });
});

describe("compileLineFilter", () => {
  it("keeps everything without patterns", () => {
    const filter = compileLineFilter({ include: undefined, exclude: undefined });
    assert.ok(typeof filter === "function" && filter("anything"));
  });

  it("applies include then exclude", () => {
    const filter = compileLineFilter({ include: "ERROR", exclude: "ignored" });
    assert.ok(typeof filter === "function");
    assert.equal(filter("ERROR boom"), true);
    assert.equal(filter("ERROR ignored"), false);
    assert.equal(filter("info"), false);
  });

  it("reports an invalid regex", () => {
    const filter = compileLineFilter({ include: "(", exclude: undefined });
    assert.ok(typeof filter === "object" && filter.error.includes("include"));
  });
});

describe("truncateLine", () => {
  it("cuts a long line and says how much was cut", () => {
    assert.equal(truncateLine("abcdef", 6), "abcdef");
    assert.equal(truncateLine("abcdef", 4), "abcd… [2 more characters]");
  });
});
