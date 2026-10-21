import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAnswer } from "../../src/classifier/parse.ts";

describe("parseAnswer", () => {
  it("reads a bare JSON object", () => {
    assert.deepEqual(parseAnswer('{"decision":"allow","reason":"routine"}'), { decision: "allow", reason: "routine" });
  });

  it("reads each of the three decisions", () => {
    for (const decision of ["allow", "soft_deny", "hard_deny"]) {
      assert.equal(parseAnswer(JSON.stringify({ decision, reason: "x" }))?.decision, decision);
    }
  });

  it("reads an object inside one code fence", () => {
    const reply = '```json\n{"decision":"soft_deny","reason":"pushes"}\n```';
    assert.deepEqual(parseAnswer(reply), { decision: "soft_deny", reason: "pushes" });
  });

  it("ignores whitespace around the reply", () => {
    assert.equal(parseAnswer('  \n{"decision":"allow","reason":""}\n ')?.decision, "allow");
  });

  it("uses an empty reason when the reason is missing or not text", () => {
    assert.equal(parseAnswer('{"decision":"allow"}')?.reason, "");
    assert.equal(parseAnswer('{"decision":"allow","reason":5}')?.reason, "");
  });

  it("cuts a long reason", () => {
    const reply = JSON.stringify({ decision: "allow", reason: "r".repeat(1000) });
    assert.equal(parseAnswer(reply)?.reason.length, 300);
  });

  const rejected = [
    ["two decision keys, the last one allow", '{"decision":"hard_deny","decision":"allow"}'],
    ["prose around the object", 'Sure! {"decision":"allow","reason":"ok"}'],
    ["an object after prose in a fence", 'Result:\n```json\n{"decision":"allow"}\n```'],
    ["two objects", '{"decision":"hard_deny"}{"decision":"allow"}'],
    ["an unknown decision", '{"decision":"block","reason":"x"}'],
    ["a decision with a different case", '{"decision":"Allow","reason":"x"}'],
    ["a non-string decision", '{"decision":true}'],
    ["a missing decision", '{"reason":"x"}'],
    ["an array", '["allow"]'],
    ["null", "null"],
    ["plain text", "allow"],
    ["an empty reply", ""],
  ] as const;
  for (const [name, reply] of rejected) {
    it(`rejects ${name}`, () => {
      assert.equal(parseAnswer(reply), undefined);
    });
  }
});
