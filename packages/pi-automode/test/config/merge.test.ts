import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    assert.deepEqual(config, user);
    assert.deepEqual(ignored, []);
  });

  it("does not mutate the user config it receives", () => {
    const snapshot = structuredClone(user);
    applyProjectConfig(user, { permissions: { deny: ["read(./.env*)"] } });
    assert.deepEqual(user, snapshot);
  });

  it("unions deny and ask without duplicates", () => {
    const { config } = applyProjectConfig(user, {
      permissions: { deny: ["bash(sudo:*)", "read(./.env*)"], ask: ["write(./package.json)"] },
    });
    assert.deepEqual(config.permissions.deny, ["bash(sudo:*)", "read(./.env*)"]);
    assert.deepEqual(config.permissions.ask, ["bash(git push:*)", "write(./package.json)"]);
  });

  it("ignores allow from the project layer", () => {
    const { config, ignored } = applyProjectConfig(user, {
      permissions: { allow: ["bash(rm:*)"] },
    });
    assert.deepEqual(config.permissions.allow, ["read"]);
    assert.deepEqual(ignored, ["permissions.allow"]);
  });

  describe("mode", () => {
    it("accepts a stricter mode", () => {
      assert.equal(applyProjectConfig(user, { mode: "rules" }).config.mode, "rules");
      assert.equal(applyProjectConfig(user, { mode: "ask" }).config.mode, "ask");
    });

    it("ignores a looser mode", () => {
      const strict = resolveConfig({ mode: "rules" });
      const { config, ignored } = applyProjectConfig(strict, { mode: "off" });
      assert.equal(config.mode, "rules");
      assert.deepEqual(ignored, ["mode"]);
    });

    it("does not report the same mode as ignored", () => {
      assert.deepEqual(applyProjectConfig(user, { mode: "auto" }).ignored, []);
    });

    it("accepts auto from the project when the user mode is off", () => {
      const off = resolveConfig({ mode: "off" });
      assert.equal(applyProjectConfig(off, { mode: "auto" }).config.mode, "auto");
    });

    it("ignores rules from the project when the user mode is ask", () => {
      const ask = resolveConfig({ mode: "ask" });
      const { config, ignored } = applyProjectConfig(ask, { mode: "rules" });
      assert.equal(config.mode, "ask");
      assert.deepEqual(ignored, ["mode"]);
    });
  });

  describe("allowInsideWorkingDirectory", () => {
    it("lets the project turn it off", () => {
      const { config } = applyProjectConfig(user, { allowInsideWorkingDirectory: false });
      assert.equal(config.allowInsideWorkingDirectory, false);
    });

    it("does not let the project turn it on", () => {
      const { config, ignored } = applyProjectConfig(DEFAULT_CONFIG, {
        allowInsideWorkingDirectory: true,
      });
      assert.equal(config.allowInsideWorkingDirectory, false);
      assert.deepEqual(ignored, ["allowInsideWorkingDirectory"]);
    });
  });

  describe("classifier", () => {
    it("lets the project disable the classifier", () => {
      const { config } = applyProjectConfig(user, { classifier: { enabled: false } });
      assert.equal(config.classifier.enabled, false);
    });

    it("does not let the project re-enable the classifier", () => {
      const disabled = resolveConfig({ classifier: { enabled: false } });
      const { config, ignored } = applyProjectConfig(disabled, { classifier: { enabled: true } });
      assert.equal(config.classifier.enabled, false);
      assert.deepEqual(ignored, ["classifier.enabled"]);
    });

    it("unions softDeny and hardDeny", () => {
      const { config } = applyProjectConfig(user, {
        classifier: { softDeny: ["Force pushing"], hardDeny: ["Deleting the repo"] },
      });
      assert.deepEqual(config.classifier.softDeny, ["$defaults", "Force pushing"]);
      assert.deepEqual(config.classifier.hardDeny, ["$defaults", "Deleting the repo"]);
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
      assert.deepEqual(config.classifier, user.classifier);
      assert.deepEqual(ignored, [
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
    assert.deepEqual(ignored, []);
  });

  it("ignores log from the project layer", () => {
    const { config, ignored } = applyProjectConfig(user, { log: { classifierIo: true } });
    assert.deepEqual(config.log, user.log);
    assert.deepEqual(ignored, ["log"]);
  });
});
