import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { configPath, DEFAULT_CONFIG, loadMonitorConfig } from "../src/config.ts";
import { footerText } from "../src/footer.ts";

function load(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), "monitor-config-"));
  if (text !== undefined) writeFileSync(configPath(dir), text);
  return loadMonitorConfig(configPath(dir));
}

describe("loadMonitorConfig", () => {
  it("uses the defaults without a file", () => {
    assert.deepEqual(load(), { config: DEFAULT_CONFIG });
  });

  it("overrides only the fields that are set", () => {
    assert.deepEqual(load('{"batchMs":500}'), { config: { ...DEFAULT_CONFIG, batchMs: 500 } });
  });

  it("reports broken JSON", () => {
    assert.ok("errors" in load("{ nope"));
  });

  it("reports a wrong type, a value out of range and an unknown key", () => {
    for (const text of ['{"batchMs":"10"}', '{"batchMs":5}', '{"maxMonitors":0}', '{"maxMonitors":17}', '{"maxEventsPerMinute":0}', '{"timeout":1}']) {
      assert.ok("errors" in load(text), text);
    }
  });
});

describe("footerText", () => {
  it("says idle when nothing runs and starts with an emoji without a key prefix", () => {
    assert.equal(footerText(0), "👁️ idle");
    assert.equal(footerText(2), "👁️ 2 watching");
    for (const text of [footerText(0), footerText(2)]) {
      assert.match(text, /^👁️ /u);
      assert.doesNotMatch(text, /monitor\s*:/i);
      assert.doesNotMatch(text, /\)\s*$/);
    }
  });
});
