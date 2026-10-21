import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("overrides only the nested keys that are given", () => {
    const config = resolveConfig({ classifier: { context: { userTokens: 100 } } });
    expect(config.classifier.context).toEqual({ userTokens: 100, toolTokens: 4000 });
  });

  it("does not mutate the shared defaults", () => {
    resolveConfig({}).permissions.deny.push("x");
    expect(DEFAULT_CONFIG.permissions.deny).toEqual([]);
  });
});

describe("readConfigFile", () => {
  it("returns missing when the file does not exist", () => {
    expect(readConfigFile(join(dir, "nope.json"))).toEqual({ status: "missing" });
  });

  it("accepts a valid config", () => {
    const path = writeJson("ok.json", { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } });
    expect(readConfigFile(path)).toEqual({
      status: "ok",
      file: { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } },
    });
  });

  it.each([
    ["not JSON", "{ nope"],
    ["unknown nested key (typo)", { permissions: { dney: [] } }],
    ["unknown top-level key", { modee: "auto" }],
    ["mode outside the enum", { mode: "yolo" }],
    ["rule that is not a string", { permissions: { deny: [1] } }],
    ["empty rule string", { permissions: { deny: [""] } }],
    ["model without a provider", { classifier: { model: "claude-haiku-5-5" } }],
    ["timeoutMs below 1000", { classifier: { timeoutMs: 999 } }],
    ["reasoningLevel outside the enum", { classifier: { reasoningLevel: "ultra" } }],
  ])("rejects an invalid config: %s", (_name, content) => {
    expect(readConfigFile(writeJson("bad.json", content)).status).toBe("invalid");
  });

  it.each([
    ["null", "null"],
    ["an array", "[]"],
    ["a __proto__ key", '{"__proto__": {"mode": "off"}}'],
    ["an empty file", ""],
  ])("rejects an unusual top-level value: %s", (_name, text) => {
    expect(readConfigFile(writeJson("bad.json", text)).status).toBe("invalid");
  });

  it("treats a directory as invalid", () => {
    expect(readConfigFile(dir).status).toBe("invalid");
  });

  it("treats a file over the size limit as invalid", () => {
    const path = writeJson("big.json", `{"mode": "auto"}${" ".repeat(1024 * 1024)}`);
    expect(readConfigFile(path).status).toBe("invalid");
  });

  it("includes the file path and field location in the error message", () => {
    const path = writeJson("bad.json", { classifier: { timeoutMs: 1 } });
    const result = readConfigFile(path);
    if (result.status !== "invalid") throw new Error("expected invalid");
    expect(result.errors.some((e) => e.includes(path) && e.includes("/classifier/timeoutMs"))).toBe(
      true,
    );
  });
});

describe("loadConfig", () => {
  const missing = () => join(dir, "missing.json");

  it("uses the defaults when neither file exists", () => {
    const result = loadConfig({ user: missing(), project: missing() });
    expect(result).toEqual({ config: DEFAULT_CONFIG, errors: [], ignored: [] });
  });

  it("applies the user layer, then the project layer's tightening", () => {
    const user = writeJson("user.json", { permissions: { deny: ["bash(sudo:*)"] } });
    const project = writeJson("project.json", {
      mode: "ask",
      permissions: { deny: ["read(./.env*)"] },
    });
    const { config, errors } = loadConfig({ user, project });
    expect(errors).toEqual([]);
    expect(config.mode).toBe("ask");
    expect(config.permissions.deny).toEqual(["bash(sudo:*)", "read(./.env*)"]);
  });

  it("reports the project-layer fields that were ignored", () => {
    const project = writeJson("project.json", { permissions: { allow: ["bash(rm:*)"] } });
    const { ignored } = loadConfig({ user: missing(), project });
    expect(ignored).toEqual(["permissions.allow"]);
  });

  it("reports errors, falls back to the defaults and forces ask when the user config is invalid", () => {
    const user = writeJson("user.json", { mode: "off", permissions: { dney: [] } });
    const { config, errors } = loadConfig({ user, project: missing() });
    expect(errors.length).toBeGreaterThan(0);
    expect(config).toEqual({ ...DEFAULT_CONFIG, mode: "ask" });
  });

  it("tells the user that deny rules in an invalid file are not in effect", () => {
    const user = writeJson("user.json", { permissions: { deny: ["bash(sudo:*)"] }, nope: 1 });
    const { errors } = loadConfig({ user, project: missing() });
    const notice = errors.find((e) => e.includes("none of its rules (including deny)"));
    expect(notice).toContain(user);
  });

  it("reports the errors of both files when both are invalid", () => {
    const user = writeJson("user.json", "{ nope");
    const project = writeJson("project.json", "[]");
    const { errors } = loadConfig({ user, project });
    expect(errors.some((e) => e.includes(user))).toBe(true);
    expect(errors.some((e) => e.includes(project))).toBe(true);
  });

  it("keeps the user layer but forces ask when the project config is invalid", () => {
    const user = writeJson("user.json", {
      mode: "off",
      permissions: { deny: ["bash(sudo:*)"] },
    });
    const project = writeJson("project.json", "{ nope");
    const { config, errors } = loadConfig({ user, project });
    expect(errors.length).toBeGreaterThan(0);
    expect(config.mode).toBe("ask");
    expect(config.permissions.deny).toEqual(["bash(sudo:*)"]);
  });
});
