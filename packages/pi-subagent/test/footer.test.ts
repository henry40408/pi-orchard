import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { footerText } from "../src/footer.ts";

describe("footerText", () => {
  it("says idle when nothing runs", () => {
    assert.equal(footerText(0), "🤖 idle");
  });

  it("starts with an emoji and has neither a key prefix nor trailing parentheses", () => {
    for (const text of [footerText(0), footerText(2)]) {
      assert.match(text, /^🤖 /u);
      assert.doesNotMatch(text, /subagent\s*:/i);
      assert.doesNotMatch(text, /\)\s*$/);
    }
    assert.equal(footerText(2), "🤖 2 running");
  });
});
