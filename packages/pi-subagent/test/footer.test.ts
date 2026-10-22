import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { footerText } from "../src/footer.ts";

describe("footerText", () => {
  it("clears the entry when nothing runs", () => {
    assert.equal(footerText(0), undefined);
  });

  it("starts with an emoji and has neither a key prefix nor trailing parentheses", () => {
    const text = footerText(2) ?? "";
    assert.equal(text, "🤖 2 running");
    assert.doesNotMatch(text, /subagent\s*:/i);
    assert.doesNotMatch(text, /\)\s*$/);
  });
});
