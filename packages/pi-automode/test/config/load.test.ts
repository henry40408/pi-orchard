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
  it("空設定等於預設值", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it("巢狀欄位只覆蓋有給的 key", () => {
    const config = resolveConfig({ classifier: { context: { userTokens: 100 } } });
    expect(config.classifier.context).toEqual({ userTokens: 100, toolTokens: 4000 });
  });

  it("不會改到共用的預設值", () => {
    resolveConfig({}).permissions.deny.push("x");
    expect(DEFAULT_CONFIG.permissions.deny).toEqual([]);
  });
});

describe("readConfigFile", () => {
  it("檔案不存在時回傳 missing", () => {
    expect(readConfigFile(join(dir, "nope.json"))).toEqual({ status: "missing" });
  });

  it("接受有效的設定", () => {
    const path = writeJson("ok.json", { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } });
    expect(readConfigFile(path)).toEqual({
      status: "ok",
      file: { mode: "rules", permissions: { deny: ["bash(sudo:*)"] } },
    });
  });

  it.each([
    ["不是 JSON", "{ nope"],
    ["未知的 key（拼錯）", { permissions: { dney: [] } }],
    ["未知的頂層 key", { modee: "auto" }],
    ["mode 不在列舉內", { mode: "yolo" }],
    ["規則不是字串", { permissions: { deny: [1] } }],
    ["規則是空字串", { permissions: { deny: [""] } }],
    ["model 沒有 provider", { classifier: { model: "claude-haiku-5-5" } }],
    ["timeoutMs 小於 1000", { classifier: { timeoutMs: 999 } }],
    ["reasoningLevel 不在列舉內", { classifier: { reasoningLevel: "ultra" } }],
  ])("拒絕無效的設定：%s", (_name, content) => {
    const result = readConfigFile(writeJson("bad.json", content));
    expect(result.status).toBe("invalid");
  });

  it.each([
    ["null", "null"],
    ["陣列", "[]"],
    ["__proto__ key", '{"__proto__": {"mode": "off"}}'],
    ["空檔案", ""],
  ])("拒絕頂層異常的內容：%s", (_name, text) => {
    expect(readConfigFile(writeJson("bad.json", text)).status).toBe("invalid");
  });

  it("路徑是目錄時視為無效", () => {
    expect(readConfigFile(dir).status).toBe("invalid");
  });

  it("檔案超過大小上限時視為無效，且不讀取內容", () => {
    const path = writeJson("big.json", `{"mode": "auto"}${" ".repeat(1024 * 1024)}`);
    const result = readConfigFile(path);
    expect(result.status).toBe("invalid");
  });

  it("錯誤訊息包含檔案路徑與欄位位置", () => {
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

  it("兩個檔案都不存在時使用預設值", () => {
    const result = loadConfig({ user: missing(), project: missing() });
    expect(result).toEqual({ config: DEFAULT_CONFIG, errors: [], ignored: [] });
  });

  it("套用使用者層，再套用專案層的收緊", () => {
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

  it("回報專案層被忽略的項目", () => {
    const project = writeJson("project.json", { permissions: { allow: ["bash(rm:*)"] } });
    const { ignored } = loadConfig({ user: missing(), project });
    expect(ignored).toEqual(["permissions.allow"]);
  });

  it("使用者設定無效時回報錯誤，改用預設值並強制 ask", () => {
    const user = writeJson("user.json", { mode: "off", permissions: { dney: [] } });
    const { config, errors } = loadConfig({ user, project: missing() });
    expect(errors.length).toBeGreaterThan(0);
    expect(config).toEqual({ ...DEFAULT_CONFIG, mode: "ask" });
  });

  it("提醒使用者無效檔案裡的 deny 規則未生效", () => {
    const user = writeJson("user.json", { permissions: { deny: ["bash(sudo:*)"] }, nope: 1 });
    const { errors } = loadConfig({ user, project: missing() });
    expect(errors.some((e) => e.includes(user) && e.includes("deny") && e.includes("未生效"))).toBe(
      true,
    );
  });

  it("兩個檔案都無效時，兩邊的錯誤都會回報", () => {
    const user = writeJson("user.json", "{ nope");
    const project = writeJson("project.json", "[]");
    const { errors } = loadConfig({ user, project });
    expect(errors.some((e) => e.includes(user))).toBe(true);
    expect(errors.some((e) => e.includes(project))).toBe(true);
  });

  it("專案設定無效時保留使用者層，但強制 ask", () => {
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
