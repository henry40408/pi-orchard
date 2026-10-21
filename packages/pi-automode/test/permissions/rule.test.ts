import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRule } from "../../src/permissions/rule.ts";

describe("parseRule", () => {
  it("parses a rule without a specifier", () => {
    assert.deepEqual(parseRule("read"), { raw: "read", tool: "read", specifier: undefined });
  });

  it("parses a rule with a specifier", () => {
    assert.deepEqual(parseRule("bash(git push:*)"), {
      raw: "bash(git push:*)",
      tool: "bash",
      specifier: "git push:*",
    });
  });

  it("keeps parentheses inside the specifier", () => {
    assert.equal(parseRule("bash(echo (a))").specifier, "echo (a)");
  });

  it("lower-cases the tool name", () => {
    assert.equal(parseRule("Read(./.env)").tool, "read");
    assert.equal(parseRule("Bash").tool, "bash");
  });

  it("accepts extension tool names", () => {
    assert.equal(parseRule("my-tool.v2").tool, "my-tool.v2");
  });

  for (const raw of ["", "bash(", "bash()", "(x)", "bash(x)y", "a b"]) {
    it(`rejects "${raw}"`, () => {
      assert.throws(() => parseRule(raw));
    });
  }
});
