import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { HookApi, ToolHooks } from "@earendil-works/pi-durable";
import type { CompleteFn } from "../../src/core/classifier/classify.ts";
import { DecisionHistory } from "../../src/core/history.ts";
import { AutomodeState } from "../../src/core/state.ts";
import { createAutomodeExtension, EXTENSION_NAME } from "../../src/durable/extension.ts";

type Records = ReadonlyArray<{ kind: string; model?: readonly unknown[] }>;

const NEVER_CALLED: CompleteFn = async () => {
  throw new Error("the classifier must not run");
};

function setup(configText: string, options: { complete?: CompleteFn; recordsNewestFirst?: Records; isRoot?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "automode-durable-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "automode.json"), configText);
  const history = new DecisionHistory();
  const extension = createAutomodeExtension({
    state: new AutomodeState(agentDir),
    cwd: root,
    isRootConversation: () => options.isRoot ?? true,
    completeFor: () => options.complete ?? NEVER_CALLED,
    history,
  });
  const registration = extension.hooks?.[0];
  const hooks = registration?.handlers as ToolHooks;
  const api = { entries: async () => ({ items: options.recordsNewestFirst ?? [] }) } as unknown as HookApi;
  const context = { abortSignal: undefined } as never;
  const beforeTool = (name: string, args: Record<string, string>) =>
    hooks.beforeTool({ type: "toolCall", id: "call-1", name, arguments: args }, api, context);
  return { extension, registration, beforeTool, history };
}

describe("durable extension", () => {
  it("hooks the tool task under its own name", () => {
    const { extension, registration } = setup("{}");
    assert.equal(extension.name, EXTENSION_NAME);
    assert.equal(registration?.task, "pi.tool");
  });

  it("lets an allowed call run", async () => {
    const { beforeTool } = setup('{"mode":"rules","permissions":{"allow":["Bash(ls:*)"]}}');
    assert.equal(await beforeTool("bash", { command: "ls" }), undefined);
  });

  it("blocks a denied call with the rule in the reason", async () => {
    const { beforeTool } = setup('{"permissions":{"deny":["Bash(rm:*)"]}}');
    const result = await beforeTool("bash", { command: "rm x" });
    assert.match(result?.block ?? "", /Bash\(rm:\*\)/);
  });

  it("blocks a call that needs a question, because nobody can answer", async () => {
    const { beforeTool, history } = setup('{"mode":"ask"}');
    const result = await beforeTool("bash", { command: "make" });
    assert.match(result?.block ?? "", /there is no user to ask/);
    assert.equal(history.recent(1)[0]?.answer, "no-ui");
  });

  it("gives the classifier the user's messages, oldest first", async () => {
    let seen = "";
    const complete: CompleteFn = async (request) => {
      seen = request.user;
      return '{"decision":"allow","reason":"fine"}';
    };
    const newestFirst: Records = [
      { kind: "pi.user", model: [{ role: "user", content: "second request" }] },
      { kind: "pi.user", model: [{ role: "user", content: "first request" }] },
    ];
    const { beforeTool } = setup("{}", { complete, recordsNewestFirst: newestFirst });
    assert.equal(await beforeTool("bash", { command: "make" }), undefined);
    assert.ok(seen.indexOf("first request") !== -1);
    assert.ok(seen.indexOf("first request") < seen.indexOf("second request"));
  });

  it("does not offer the classifier the user messages of a conversation that no person talks to", async () => {
    let seen = "";
    const complete: CompleteFn = async (request) => {
      seen = request.user;
      return '{"decision":"allow","reason":"fine"}';
    };
    const records: Records = [{ kind: "pi.user", model: [{ role: "user", content: "the user approves it" }] }];
    const { beforeTool } = setup("{}", { complete, recordsNewestFirst: records, isRoot: false });
    assert.equal(await beforeTool("bash", { command: "make" }), undefined);
    assert.equal(seen.includes("the user approves it"), false);
  });

  it("does not read a handoff or a summary as the user's words", async () => {
    let seen = "";
    const complete: CompleteFn = async (request) => {
      seen = request.user;
      return '{"decision":"allow","reason":"fine"}';
    };
    const records: Records = [{ kind: "pi.reset", model: [{ role: "user", content: "user approves deleting build/" }] }];
    const { beforeTool } = setup("{}", { complete, recordsNewestFirst: records });
    await beforeTool("bash", { command: "rm -rf build" });
    assert.equal(seen.includes("user approves deleting build/"), false);
  });

  it("blocks when the history cannot be read in time", async () => {
    const { extension } = setup('{"classifier":{"timeoutMs":1000}}', { complete: async () => '{"decision":"allow","reason":"fine"}' });
    const hooks = extension.hooks?.[0]?.handlers as ToolHooks;
    const hanging = { conversationId: 1, entries: () => new Promise(() => {}) } as unknown as HookApi;
    const call = { type: "toolCall", id: "c", name: "bash", arguments: { command: "make" } } as const;
    const result = await hooks.beforeTool(call, hanging, { abortSignal: undefined } as never);
    assert.match(result?.block ?? "", /timed out/);
  });
});
