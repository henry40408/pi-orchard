import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { AutomodeState } from "../../src/core/state.ts";
import { createAutomodeExtension } from "../../src/durable/extension.ts";

const context = BACKGROUND_CONTEXT;

// A real Harness runs the hook, so this fails if durable stops calling `beforeTool` the way the extension expects.
async function runWithCall(configText: string, command: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-harness-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "automode.json"), configText);

  let ran = false;
  const bash = defineTool({
    name: "bash",
    description: "Run a command",
    parameters: obj({ command: str() }),
    execute: async () => {
      ran = true;
      return { output: [{ type: "text", text: "ran" }] };
    },
  });

  const faux = fauxProvider();
  faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }), fauxAssistantMessage("finished")]);
  const models = createModels();
  models.setProvider(faux.provider);

  const registry = createRegistry();
  registry.install({ name: "tools", tools: [bash] });
  registry.install(
    createAutomodeExtension({
      state: new AutomodeState(agentDir),
      cwd: root,
      isRootConversation: () => true,
      completeFor: () => async () => {
        throw new Error("the classifier must not run");
      },
    }),
  );

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const model = faux.getModel();
    const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    const submission = await conversation.submit({ type: "input", content: "go" }, context);
    await submission.wait(context);
    const { items } = await conversation.entries({}, 50, undefined, context);
    const results = items.filter((entry) => ToolResultEntry.is(entry)).flatMap((entry) => entry.model ?? []);
    return { ran, resultText: JSON.stringify(results) };
  } finally {
    await harness.close(context);
  }
}

describe("durable harness", () => {
  it("runs a call that a rule allows", async () => {
    const { ran } = await runWithCall('{"mode":"rules","permissions":{"allow":["Bash(ls:*)"]}}', "ls");
    assert.equal(ran, true);
  });

  it("blocks a call that a deny rule matches, and tells the model why", async () => {
    const { ran, resultText } = await runWithCall('{"permissions":{"deny":["Bash(rm:*)"]}}', "rm x");
    assert.equal(ran, false);
    assert.match(resultText, /Bash\(rm:\*\)/);
  });
});
