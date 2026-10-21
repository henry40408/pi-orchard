import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { DEFAULT_CONFIG, resolveConfig } from "../../src/config/defaults.ts";
import { loadConfig, readConfigFile } from "../../src/config/load.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-automode-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name: string, content: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
  return path;
}

describe("resolveConfig", () => {
  it("returns the defaults for an empty config", () => {
    assert.deepEqual(resolveConfig({}), DEFAULT_CONFIG);
  });

  it("overrides only the nested keys that are given", () => {
    const config = resolveConfig({ classifier: { context: { userTokens: 100 } } });
    assert.deepEqual(config.classifier.context, { userTokens: 100, toolTokens: 4000 });
  });

  it("does not mutate the shared defaults", () => {
    resolveConfig({}).permissions.deny.push("x");
    assert.deepEqual(DEFAULT_CONFIG.permissions.deny, []);
  });
});

describe("readConfigFile", () => {
  it("returns missing when the file does not exist", () => {
    assert.deepEqual(readConfigFile(join(dir, "nope.json")), { status: "missing" });
  });

  it("accepts a valid config", () => {
    const path = writeJson("ok.json", { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } });
    assert.deepEqual(readConfigFile(path), {
      status: "ok",
      file: { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } },
    });
  });

  const invalidConfigs: [string, unknown][] = [
    ["not JSON", "{ nope"],
    ["unknown nested key (typo)", { permissions: { dney: [] } }],
    ["unknown top-level key", { modee: "auto" }],
    ["mode outside the enum", { mode: "yolo" }],
    ["rule that is not a string", { permissions: { deny: [1] } }],
    ["empty rule string", { permissions: { deny: [""] } }],
    ["rule with an unclosed specifier", { permissions: { deny: ["bash(rm"] } }],
    ["rule with an empty specifier", { permissions: { deny: ["bash()"] } }],
    ["rule without a tool name", { permissions: { deny: ["(rm)"] } }],
    ["model without a provider", { classifier: { model: "claude-haiku-5-5" } }],
    ["timeoutMs below 1000", { classifier: { timeoutMs: 999 } }],
    ["reasoningLevel outside the enum", { classifier: { reasoningLevel: "ultra" } }],
    ["null", "null"],
    ["an array", "[]"],
    ["a __proto__ key", '{"__proto__": {"mode": "off"}}'],
    ["an empty file", ""],
  ];
  for (const [name, content] of invalidConfigs) {
    it(`rejects an invalid config: ${name}`, () => {
      assert.equal(readConfigFile(writeJson("bad.json", content)).status, "invalid");
    });
  }

  it("treats a directory as invalid", () => {
    assert.equal(readConfigFile(dir).status, "invalid");
  });

  it("treats a file over the size limit as invalid", () => {
    const path = writeJson("big.json", `{"mode": "auto"}${" ".repeat(1024 * 1024)}`);
    assert.equal(readConfigFile(path).status, "invalid");
  });

  it("includes the file path and field location in the error message", () => {
    const path = writeJson("bad.json", { classifier: { timeoutMs: 1 } });
    const result = readConfigFile(path);
    assert.equal(result.status, "invalid");
    assert.ok(
      result.status === "invalid" &&
        result.errors.some((e) => e.includes(path) && e.includes("/classifier/timeoutMs")),
    );
  });
});

describe("loadConfig", () => {
  const missing = () => join(dir, "missing.json");

  it("uses the defaults when neither file exists", () => {
    const result = loadConfig({ user: missing(), project: missing() });
    assert.deepEqual(result, { config: DEFAULT_CONFIG, errors: [], ignored: [] });
  });

  it("applies the user layer, then the project layer's tightening", () => {
    const user = writeJson("user.json", { permissions: { deny: ["bash(sudo:*)"] } });
    const project = writeJson("project.json", {
      mode: "ask",
      permissions: { deny: ["read(./.env*)"] },
    });
    const { config, errors } = loadConfig({ user, project });
    assert.deepEqual(errors, []);
    assert.equal(config.mode, "ask");
    assert.deepEqual(config.permissions.deny, ["bash(sudo:*)", "read(./.env*)"]);
  });

  it("reports the project-layer fields that were ignored", () => {
    const project = writeJson("project.json", { permissions: { allow: ["bash(rm:*)"] } });
    const { ignored } = loadConfig({ user: missing(), project });
    assert.deepEqual(ignored, ["permissions.allow"]);
  });

  it("reports errors, falls back to the defaults and forces ask when the user config is invalid", () => {
    const user = writeJson("user.json", { mode: "off", permissions: { dney: [] } });
    const { config, errors } = loadConfig({ user, project: missing() });
    assert.ok(errors.length > 0);
    assert.deepEqual(config, { ...DEFAULT_CONFIG, mode: "ask" });
  });

  it("tells the user that deny rules in an invalid file are not in effect", () => {
    const user = writeJson("user.json", { permissions: { deny: ["bash(sudo:*)"] }, nope: 1 });
    const { errors } = loadConfig({ user, project: missing() });
    const notice = errors.find((e) => e.includes("none of its rules (including deny)"));
    assert.ok(notice?.includes(user));
  });

  it("reports the errors of both files when both are invalid", () => {
    const user = writeJson("user.json", "{ nope");
    const project = writeJson("project.json", "[]");
    const { errors } = loadConfig({ user, project });
    assert.ok(errors.some((e) => e.includes(user)));
    assert.ok(errors.some((e) => e.includes(project)));
  });

  it("keeps the user layer but forces ask when the project config is invalid", () => {
    const user = writeJson("user.json", {
      mode: "off",
      permissions: { deny: ["bash(sudo:*)"] },
    });
    const project = writeJson("project.json", "{ nope");
    const { config, errors } = loadConfig({ user, project });
    assert.ok(errors.length > 0);
    assert.equal(config.mode, "ask");
    assert.deepEqual(config.permissions.deny, ["bash(sudo:*)"]);
  });
});
