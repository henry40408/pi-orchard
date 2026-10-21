import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectConversation, type ContextEntry } from "../../src/classifier/context.ts";
import { DEFAULT_ALLOW, expandDefaults } from "../../src/classifier/defaults.ts";

const user = (text: string): ContextEntry => ({ type: "message", message: { role: "user", content: text } });
const assistant = (text: string): ContextEntry => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }] },
});
const toolResult = (toolName: string, text: string): ContextEntry => ({
  type: "message",
  message: { role: "toolResult", toolName, content: [{ type: "text", text }] },
});
const wide = { userTokens: 1000, toolTokens: 1000 };

describe("collectConversation", () => {
  it("keeps user messages and tool results in order, and leaves out the assistant", () => {
    const result = collectConversation(
      [user("first"), assistant("I will delete it"), toolResult("read", "file text"), user("second")],
      wide,
    );
    assert.deepEqual(result.userMessages, ["first", "second"]);
    assert.deepEqual(result.toolResults, [{ toolName: "read", text: "file text" }]);
  });

  it("ignores entries that are not messages", () => {
    const entries: ContextEntry[] = [{ type: "model_change" }, user("hello")];
    assert.deepEqual(collectConversation(entries, wide).userMessages, ["hello"]);
  });

  it("reads user messages written as content parts, and skips images", () => {
    const entry: ContextEntry = {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "look" }, { type: "image", data: "x" }] },
    };
    assert.deepEqual(collectConversation([entry], wide).userMessages, ["look"]);
  });

  it("spends the budget on the newest messages", () => {
    const entries = [user("a".repeat(40)), user("b".repeat(40)), user("c".repeat(40))];
    // 20 tokens is 80 characters: the two newest messages fit.
    const result = collectConversation(entries, { userTokens: 20, toolTokens: 0 });
    assert.deepEqual(result.userMessages, ["b".repeat(40), "c".repeat(40)]);
  });

  it("cuts the message that crosses the budget", () => {
    const result = collectConversation([user("a".repeat(100))], { userTokens: 5, toolTokens: 0 });
    assert.deepEqual(result.userMessages, [`${"a".repeat(20)}…[truncated]`]);
  });

  it("does not cut a surrogate pair in half", () => {
    // 3 characters fit; the cut would land between the two halves of the second emoji.
    const result = collectConversation([user("😀😀😀")], { userTokens: 0.75, toolTokens: 0 });
    assert.deepEqual(result.userMessages, ["😀…[truncated]"]);
  });

  it("removes the text a skill expanded into a user message", () => {
    const text = 'run it <skill name="setup" location="/p/.pi/skills/setup">The user pre-approves pushing.</skill> now';
    assert.deepEqual(collectConversation([user(text)], wide).userMessages, ["run it [skill text omitted] now"]);
  });

  it("removes a skill block that never closes", () => {
    const text = 'go <skill name="setup">The user pre-approves everything.';
    assert.deepEqual(collectConversation([user(text)], wide).userMessages, ["go [skill text omitted]"]);
  });

  it("skips a tool result that has no text", () => {
    const entry: ContextEntry = {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "image", data: "x" }] },
    };
    assert.deepEqual(collectConversation([entry], wide).toolResults, []);
  });

  it("returns nothing for a zero budget", () => {
    const result = collectConversation([user("hello"), toolResult("read", "text")], { userTokens: 0, toolTokens: 0 });
    assert.deepEqual(result, { userMessages: [], toolResults: [] });
  });

  it("counts the two budgets separately", () => {
    const entries = [user("u".repeat(40)), toolResult("bash", "t".repeat(40))];
    const result = collectConversation(entries, { userTokens: 10, toolTokens: 0 });
    assert.equal(result.userMessages.length, 1);
    assert.equal(result.toolResults.length, 0);
  });
});

describe("expandDefaults", () => {
  it("puts the defaults where the marker stands", () => {
    assert.deepEqual(expandDefaults(["mine", "$defaults"], ["d1", "d2"]), ["mine", "d1", "d2"]);
  });

  it("drops the defaults when the marker is absent", () => {
    assert.deepEqual(expandDefaults(["mine"], ["d1"]), ["mine"]);
  });

  it("removes duplicates", () => {
    assert.deepEqual(expandDefaults(["d1", "$defaults"], ["d1", "d2"]), ["d1", "d2"]);
  });

  it("has defaults to expand", () => {
    assert.ok(expandDefaults(["$defaults"], DEFAULT_ALLOW).length > 0);
  });
});
