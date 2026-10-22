import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ClassifierVerdict } from "../src/classifier/classify.ts";
import { DEFAULT_CONFIG } from "../src/config/defaults.ts";
import type { Config } from "../src/config/schema.ts";
import { decide } from "../src/decide.ts";
import { createPathContext } from "../src/permissions/paths.ts";

const pathContext = createPathContext(process.cwd());

function config(overrides: Partial<Config> = {}, permissions: Partial<Config["permissions"]> = {}): Config {
  return {
    ...DEFAULT_CONFIG,
    mode: "auto",
    allowInsideWorkingDirectory: false,
    ...overrides,
    permissions: { allow: [], ask: [], deny: [], ...permissions },
  };
}

async function run(configuration: Config, toolName: string, input: unknown, verdict?: ClassifierVerdict) {
  let classified = 0;
  const outcome = await decide({
    config: configuration,
    toolName,
    input,
    pathContext,
    classifyAction: async () => {
      classified += 1;
      return verdict ?? { decision: "ask", reason: "classifier default" };
    },
  });
  return { outcome, classified };
}

describe("decide", () => {
  it("allows everything in off mode without evaluating rules", async () => {
    const { outcome, classified } = await run(config({ mode: "off" }, { deny: ["Bash(rm:*)"] }), "bash", { command: "rm x" });
    assert.equal(outcome.action, "allow");
    assert.equal(outcome.source, "off");
    assert.equal(classified, 0);
  });

  it("blocks on a deny rule even in ask mode", async () => {
    const { outcome } = await run(config({ mode: "ask" }, { deny: ["Bash(rm:*)"] }), "bash", { command: "rm x" });
    assert.equal(outcome.action, "block");
    assert.equal(outcome.source, "deny");
  });

  it("asks in ask mode even with an allow rule", async () => {
    const { outcome } = await run(config({ mode: "ask" }, { allow: ["Bash(ls:*)"] }), "bash", { command: "ls" });
    assert.equal(outcome.action, "ask");
    assert.equal(outcome.source, "mode");
  });

  it("asks on an ask rule and does not call the classifier", async () => {
    const { outcome, classified } = await run(config({}, { ask: ["Bash(git push:*)"] }), "bash", { command: "git push" });
    assert.equal(outcome.action, "ask");
    assert.equal(outcome.source, "rule");
    assert.equal(classified, 0);
  });

  it("allows on an allow rule without the classifier", async () => {
    const { outcome, classified } = await run(config({}, { allow: ["Bash(ls:*)"] }), "bash", { command: "ls" });
    assert.equal(outcome.action, "allow");
    assert.equal(outcome.source, "rule");
    assert.equal(classified, 0);
  });

  it("lets a deny rule win over an allow rule", async () => {
    const { outcome } = await run(config({}, { allow: ["Bash(rm:*)"], deny: ["Bash(rm:*)"] }), "bash", { command: "rm x" });
    assert.equal(outcome.action, "block");
  });

  it("allows a file inside the working directory when the shortcut is on", async () => {
    const { outcome, classified } = await run(config({ allowInsideWorkingDirectory: true }), "read", { path: "package.json" });
    assert.equal(outcome.action, "allow");
    assert.equal(outcome.source, "shortcut");
    assert.equal(classified, 0);
  });

  it("never applies the working-directory shortcut to bash", async () => {
    const { classified } = await run(config({ allowInsideWorkingDirectory: true }), "bash", { command: "cat package.json" });
    assert.equal(classified, 1);
  });

  it("does not apply the shortcut outside the working directory", async () => {
    const { classified } = await run(config({ allowInsideWorkingDirectory: true }), "read", { path: "/usr/share/example.txt" });
    assert.equal(classified, 1);
  });

  it("does not apply the shortcut to files that run code by themselves", async () => {
    for (const path of [".git/config", ".git/hooks/pre-commit", ".pi/settings.json", ".envrc", "sub/.git/config"]) {
      const { classified } = await run(config({ allowInsideWorkingDirectory: true }), "write", { path, content: "x" });
      assert.equal(classified, 1, path);
    }
  });

  it("asks in rules mode when no rule decides", async () => {
    const { outcome, classified } = await run(config({ mode: "rules" }), "bash", { command: "make" });
    assert.equal(outcome.action, "ask");
    assert.equal(outcome.source, "mode");
    assert.equal(classified, 0);
  });

  it("asks when the classifier is disabled", async () => {
    const disabled = config();
    disabled.classifier = { ...disabled.classifier, enabled: false };
    const { outcome, classified } = await run(disabled, "bash", { command: "make" });
    assert.equal(outcome.action, "ask");
    assert.equal(outcome.source, "mode");
    assert.equal(classified, 0);
  });

  it("maps classifier verdicts to actions", async () => {
    const allow = await run(config(), "bash", { command: "make" }, { decision: "allow", reason: "ok" });
    const ask = await run(config(), "bash", { command: "make" }, { decision: "ask", reason: "hmm" });
    const deny = await run(config(), "bash", { command: "make" }, { decision: "deny", reason: "no" });
    assert.deepEqual([allow.outcome.action, ask.outcome.action, deny.outcome.action], ["allow", "ask", "block"]);
    assert.equal(deny.outcome.reason, "no");
    assert.equal(allow.outcome.source, "classifier");
  });
});
