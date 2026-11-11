import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_CONFIG } from "../../src/core/config.ts";
import { createMonitorExtension, type MonitorExtensionOptions } from "../../src/durable/extension.ts";

const context = BACKGROUND_CONTEXT;

type ToolCall = ReturnType<typeof fauxToolCall>;

async function open(deliver: MonitorExtensionOptions["deliver"], onDeliveryError?: (error: unknown) => void) {
  const root = mkdtempSync(join(tmpdir(), "monitor-conversations-"));
  const { extension, stopAll } = createMonitorExtension({
    loadConfig: () => ({ config: { ...DEFAULT_CONFIG, batchMs: 100 } }),
    deliver,
    ...(onDeliveryError === undefined ? {} : { onDeliveryError }),
  });
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);
  const harness = await Harness.open(new MemoryStorage(), { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }) }, context);
  const model = faux.getModel();

  // Each call runs in a new conversation, as one more session of the host.
  async function runInNewConversation(call: ToolCall): Promise<string> {
    faux.setResponses([fauxAssistantMessage(call, { stopReason: "toolUse" }), fauxAssistantMessage("finished")]);
    const conversation = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { model: { provider: model.provider, modelId: model.id }, cwd: root } },
      context,
    );
    await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
    const { items } = await conversation.entries({}, 50, undefined, context);
    return JSON.stringify(items.filter((entry) => ToolResultEntry.is(entry)).flatMap((entry) => entry.model ?? []));
  }
  return { runInNewConversation, stopAll, close: () => harness.close(context) };
}

describe("durable monitor conversations", () => {
  it("keeps the monitors of one conversation from another", async () => {
    const { runInNewConversation, stopAll, close } = await open(async () => {});
    try {
      assert.match(await runInNewConversation(fauxToolCall("monitor", { command: "sleep 30", description: "sleeper" })), /Started monitor mon-1/);
      assert.match(await runInNewConversation(fauxToolCall("monitor_list", {})), /No monitors in this session/);
      assert.match(await runInNewConversation(fauxToolCall("monitor_cancel", { id: "mon-1" })), /There is no monitor mon-1/);
    } finally {
      stopAll();
      await close();
    }
  });

  it("survives a deliver that throws, and reports the error", async () => {
    const errors: unknown[] = [];
    const { runInNewConversation, stopAll, close } = await open(
      () => {
        throw new Error("no way to deliver");
      },
      (error) => {
        errors.push(error);
        throw new Error("a broken report");
      },
    );
    try {
      await runInNewConversation(fauxToolCall("monitor", { command: "printf 'x\\n'", description: "once" }));
      const deadline = Date.now() + 5000;
      while (errors.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(String(errors[0]), /no way to deliver/);
    } finally {
      stopAll();
      await close();
    }
  });
});
