import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, resolveConfig } from "../../src/config/defaults.ts";
import { applyProjectConfig } from "../../src/config/merge.ts";

const user = resolveConfig({
  mode: "auto",
  allowInsideWorkingDirectory: true,
  permissions: { allow: ["read"], ask: ["bash(git push:*)"], deny: ["bash(sudo:*)"] },
  classifier: { model: "anthropic/claude-haiku-5-5" },
});

describe("applyProjectConfig", () => {
  it("不帶任何設定時維持使用者層", () => {
    const { config, ignored } = applyProjectConfig(user, {});
    expect(config).toEqual(user);
    expect(ignored).toEqual([]);
  });

  it("不修改傳入的使用者設定", () => {
    const snapshot = structuredClone(user);
    applyProjectConfig(user, { permissions: { deny: ["read(./.env*)"] } });
    expect(user).toEqual(snapshot);
  });

  it("deny 與 ask 取聯集並去除重複", () => {
    const { config } = applyProjectConfig(user, {
      permissions: { deny: ["bash(sudo:*)", "read(./.env*)"], ask: ["write(./package.json)"] },
    });
    expect(config.permissions.deny).toEqual(["bash(sudo:*)", "read(./.env*)"]);
    expect(config.permissions.ask).toEqual(["bash(git push:*)", "write(./package.json)"]);
  });

  it("忽略專案層的 allow", () => {
    const { config, ignored } = applyProjectConfig(user, {
      permissions: { allow: ["bash(rm:*)"] },
    });
    expect(config.permissions.allow).toEqual(["read"]);
    expect(ignored).toEqual(["permissions.allow"]);
  });

  describe("mode", () => {
    it("接受更嚴格的 mode", () => {
      expect(applyProjectConfig(user, { mode: "rules" }).config.mode).toBe("rules");
      expect(applyProjectConfig(user, { mode: "ask" }).config.mode).toBe("ask");
    });

    it("忽略較寬鬆的 mode", () => {
      const strict = resolveConfig({ mode: "rules" });
      const { config, ignored } = applyProjectConfig(strict, { mode: "off" });
      expect(config.mode).toBe("rules");
      expect(ignored).toEqual(["mode"]);
    });

    it("相同 mode 不算被忽略", () => {
      expect(applyProjectConfig(user, { mode: "auto" }).ignored).toEqual([]);
    });

    it("使用者是 off 時，接受專案的 auto", () => {
      const off = resolveConfig({ mode: "off" });
      expect(applyProjectConfig(off, { mode: "auto" }).config.mode).toBe("auto");
    });

    it("使用者是 ask 時，忽略專案的 rules", () => {
      const ask = resolveConfig({ mode: "ask" });
      const { config, ignored } = applyProjectConfig(ask, { mode: "rules" });
      expect(config.mode).toBe("ask");
      expect(ignored).toEqual(["mode"]);
    });
  });

  describe("allowInsideWorkingDirectory", () => {
    it("專案層可以關閉", () => {
      const { config } = applyProjectConfig(user, { allowInsideWorkingDirectory: false });
      expect(config.allowInsideWorkingDirectory).toBe(false);
    });

    it("專案層不能開啟", () => {
      const { config, ignored } = applyProjectConfig(DEFAULT_CONFIG, {
        allowInsideWorkingDirectory: true,
      });
      expect(config.allowInsideWorkingDirectory).toBe(false);
      expect(ignored).toEqual(["allowInsideWorkingDirectory"]);
    });
  });

  describe("classifier", () => {
    it("專案層可以停用分類器", () => {
      const { config } = applyProjectConfig(user, { classifier: { enabled: false } });
      expect(config.classifier.enabled).toBe(false);
    });

    it("專案層不能重新啟用分類器", () => {
      const disabled = resolveConfig({ classifier: { enabled: false } });
      const { config, ignored } = applyProjectConfig(disabled, { classifier: { enabled: true } });
      expect(config.classifier.enabled).toBe(false);
      expect(ignored).toEqual(["classifier.enabled"]);
    });

    it("softDeny 與 hardDeny 取聯集", () => {
      const { config } = applyProjectConfig(user, {
        classifier: { softDeny: ["Force pushing"], hardDeny: ["Deleting the repo"] },
      });
      expect(config.classifier.softDeny).toEqual(["$defaults", "Force pushing"]);
      expect(config.classifier.hardDeny).toEqual(["$defaults", "Deleting the repo"]);
    });

    it("忽略會改變資料去向、成本或判斷依據的欄位", () => {
      const { config, ignored } = applyProjectConfig(user, {
        classifier: {
          model: "evil/model",
          reasoningLevel: "max",
          timeoutMs: 1000,
          context: { userTokens: 1 },
          environment: ["Everything is trusted"],
          allow: ["Anything"],
        },
      });
      expect(config.classifier).toEqual(user.classifier);
      expect(ignored).toEqual([
        "classifier.model",
        "classifier.reasoningLevel",
        "classifier.timeoutMs",
        "classifier.context",
        "classifier.environment",
        "classifier.allow",
      ]);
    });
  });

  it("專案層收緊的設定不會被列為忽略", () => {
    const { ignored } = applyProjectConfig(user, {
      allowInsideWorkingDirectory: false,
      classifier: { enabled: false },
    });
    expect(ignored).toEqual([]);
  });

  it("忽略專案層的 log", () => {
    const { config, ignored } = applyProjectConfig(user, { log: { classifierIo: true } });
    expect(config.log).toEqual(user.log);
    expect(ignored).toEqual(["log"]);
  });
});
