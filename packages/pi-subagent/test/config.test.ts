import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, DEFAULT_CONFIG, loadSubagentConfig } from "../src/config.ts";

function load(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), "subagent-config-"));
  if (text !== undefined) writeFileSync(configPath(dir), text);
  return loadSubagentConfig(configPath(dir));
}

describe("loadSubagentConfig", () => {
  it("uses the defaults without a file", () => {
    assert.deepEqual(load(), { config: DEFAULT_CONFIG });
  });

  it("overrides only the fields that are set", () => {
    const result = load('{"stallTimeoutMs":30000,"model":"anthropic/claude-sonnet-5-5"}');
    assert.deepEqual(result, {
      config: { ...DEFAULT_CONFIG, stallTimeoutMs: 30000, model: "anthropic/claude-sonnet-5-5" },
    });
  });

  it("reports broken JSON", () => {
    assert.ok("errors" in load("{ nope"));
  });

  it("reports a wrong type, a value out of range, a bad model and an unknown key", () => {
    for (const text of ['{"stallTimeoutMs":"10"}', '{"stallTimeoutMs":5}', '{"maxStderrChars":10}', '{"model":"sonnet"}', '{"timeout":1}']) {
      assert.ok("errors" in load(text), text);
    }
  });
});
