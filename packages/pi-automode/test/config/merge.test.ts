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
  it("keeps the user layer when the project config is empty", () => {
    const { config, ignored } = applyProjectConfig(user, {});
    expect(config).toEqual(user);
    expect(ignored).toEqual([]);
  });

  it("does not mutate the user config it receives", () => {
    const snapshot = structuredClone(user);
    applyProjectConfig(user, { permissions: { deny: ["read(./.env*)"] } });
    expect(user).toEqual(snapshot);
  });

  it("unions deny and ask without duplicates", () => {
    const { config } = applyProjectConfig(user, {
      permissions: { deny: ["bash(sudo:*)", "read(./.env*)"], ask: ["write(./package.json)"] },
    });
    expect(config.permissions.deny).toEqual(["bash(sudo:*)", "read(./.env*)"]);
    expect(config.permissions.ask).toEqual(["bash(git push:*)", "write(./package.json)"]);
  });

  it("ignores allow from the project layer", () => {
    const { config, ignored } = applyProjectConfig(user, {
      permissions: { allow: ["bash(rm:*)"] },
    });
    expect(config.permissions.allow).toEqual(["read"]);
    expect(ignored).toEqual(["permissions.allow"]);
  });

  describe("mode", () => {
    it("accepts a stricter mode", () => {
      expect(applyProjectConfig(user, { mode: "rules" }).config.mode).toBe("rules");
      expect(applyProjectConfig(user, { mode: "ask" }).config.mode).toBe("ask");
    });

    it("ignores a looser mode", () => {
      const strict = resolveConfig({ mode: "rules" });
      const { config, ignored } = applyProjectConfig(strict, { mode: "off" });
      expect(config.mode).toBe("rules");
      expect(ignored).toEqual(["mode"]);
    });

    it("does not report the same mode as ignored", () => {
      expect(applyProjectConfig(user, { mode: "auto" }).ignored).toEqual([]);
    });

    it("accepts auto from the project when the user mode is off", () => {
      const off = resolveConfig({ mode: "off" });
      expect(applyProjectConfig(off, { mode: "auto" }).config.mode).toBe("auto");
    });

    it("ignores rules from the project when the user mode is ask", () => {
      const ask = resolveConfig({ mode: "ask" });
      const { config, ignored } = applyProjectConfig(ask, { mode: "rules" });
      expect(config.mode).toBe("ask");
      expect(ignored).toEqual(["mode"]);
    });
  });

  describe("allowInsideWorkingDirectory", () => {
    it("lets the project turn it off", () => {
      const { config } = applyProjectConfig(user, { allowInsideWorkingDirectory: false });
      expect(config.allowInsideWorkingDirectory).toBe(false);
    });

    it("does not let the project turn it on", () => {
      const { config, ignored } = applyProjectConfig(DEFAULT_CONFIG, {
        allowInsideWorkingDirectory: true,
      });
      expect(config.allowInsideWorkingDirectory).toBe(false);
      expect(ignored).toEqual(["allowInsideWorkingDirectory"]);
    });
  });

  describe("classifier", () => {
    it("lets the project disable the classifier", () => {
      const { config } = applyProjectConfig(user, { classifier: { enabled: false } });
      expect(config.classifier.enabled).toBe(false);
    });

    it("does not let the project re-enable the classifier", () => {
      const disabled = resolveConfig({ classifier: { enabled: false } });
      const { config, ignored } = applyProjectConfig(disabled, { classifier: { enabled: true } });
      expect(config.classifier.enabled).toBe(false);
      expect(ignored).toEqual(["classifier.enabled"]);
    });

    it("unions softDeny and hardDeny", () => {
      const { config } = applyProjectConfig(user, {
        classifier: { softDeny: ["Force pushing"], hardDeny: ["Deleting the repo"] },
      });
      expect(config.classifier.softDeny).toEqual(["$defaults", "Force pushing"]);
      expect(config.classifier.hardDeny).toEqual(["$defaults", "Deleting the repo"]);
    });

    it("ignores fields that change where data goes, the cost, or the judging basis", () => {
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

  it("does not report tightening settings as ignored", () => {
    const { ignored } = applyProjectConfig(user, {
      allowInsideWorkingDirectory: false,
      classifier: { enabled: false },
    });
    expect(ignored).toEqual([]);
  });

  it("ignores log from the project layer", () => {
    const { config, ignored } = applyProjectConfig(user, { log: { classifierIo: true } });
    expect(config.log).toEqual(user.log);
    expect(ignored).toEqual(["log"]);
  });
});
