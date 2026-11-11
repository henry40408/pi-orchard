import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, ToolResultEntry, UserEntry } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { DEFAULT_CONFIG, type LoadedMonitorConfig } from "../../src/core/config.ts";
import { createMonitorExtension, type DeliveryRequest } from "../../src/durable/extension.ts";

const context = BACKGROUND_CONTEXT;

type ToolCall = ReturnType<typeof fauxToolCall>;

// A real Harness runs the tools, so this fails if durable stops giving a tool the environment the extension expects.
async function runCalls(calls: ToolCall[], options: { loadConfig?: () => LoadedMonitorConfig; submitDeliveries?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "monitor-harness-"));
  const delivered: DeliveryRequest[] = [];
  const { extension, stopAll } = createMonitorExtension({
    loadConfig: options.loadConfig ?? (() => ({ config: { ...DEFAULT_CONFIG, batchMs: 100 } })),
    deliver: async (request) => {
      delivered.push(request);
      if (!options.submitDeliveries) return;
      // The snippet of the README: the host sends the text to the conversation that started the monitor.
      const conversation = await harnessRef?.conversation(request.conversationId, context);
      await conversation?.submit({ type: "input", content: request.text, requestId: request.requestId, whenBusy: "followUp" }, context);
    },
  });
  let harnessRef: Harness | undefined;

  const faux = fauxProvider();
  faux.setResponses([...calls.map((call) => fauxAssistantMessage(call, { stopReason: "toolUse" })), fauxAssistantMessage("finished"), fauxAssistantMessage("noted")]);
  const models = createModels();
  models.setProvider(faux.provider);
  const registry = createRegistry();
  registry.install(extension);

  const harness = await Harness.open(
    new MemoryStorage(),
    { models, registry, env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }) },
    context,
  );
  harnessRef = harness;
  try {
    const model = faux.getModel();
    const conversation = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id }, cwd: root } });
    await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
    const { items } = await conversation.entries({}, 50, undefined, context);
    const results = items.filter((entry) => ToolResultEntry.is(entry)).flatMap((entry) => entry.model ?? []);
    return { root, delivered, resultText: JSON.stringify(results), stopAll, harness, conversation };
  } catch (error) {
    stopAll();
    await harness.close(context);
    throw error;
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("durable harness", () => {
  it("delivers the output of a command after the tool call has ended, and a last message when it ends", async () => {
    const { delivered, resultText, harness } = await runCalls([fauxToolCall("monitor", { command: "printf 'one\\n'; sleep 0.3; printf 'two\\n'", description: "numbers" })]);
    try {
      assert.match(resultText, /Started monitor mon-1/);
      await until(() => delivered.some((message) => message.text.includes("ended")), "the end message");
      const text = delivered.map((message) => message.text).join("\n");
      assert.match(text, /one/);
      assert.match(text, /two/);
      assert.equal(new Set(delivered.map((message) => message.requestId)).size, delivered.length);
      assert.ok(delivered.every((message) => message.requestId.startsWith("monitor:")));
    } finally {
      await harness.close(context);
    }
  });

  it("wakes the model with the output when the host submits it", async () => {
    const { delivered, harness, conversation } = await runCalls([fauxToolCall("monitor", { command: "printf 'build failed\\n'", description: "build" })], { submitDeliveries: true });
    try {
      await until(() => delivered.some((message) => message.text.includes("ended")), "the end message");
      const texts = async () => {
        const { items } = await conversation.entries({}, 50, undefined, context);
        return JSON.stringify(items.filter((entry) => UserEntry.is(entry)).flatMap((entry) => entry.model ?? []));
      };
      const deadline = Date.now() + 5000;
      while (!(await texts()).includes("build failed") && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.match(await texts(), /build failed/);
    } finally {
      await harness.close(context);
    }
  });

  it("cancels a monitor on the request of the model", async () => {
    const { resultText, harness, stopAll } = await runCalls([
      fauxToolCall("monitor", { command: "sleep 30", description: "sleeper" }),
      fauxToolCall("monitor_cancel", { id: "mon-1" }),
    ]);
    try {
      assert.match(resultText, /Cancelled mon-1/);
    } finally {
      stopAll();
      await harness.close(context);
    }
  });

  it("kills the command when the monitors are stopped", async () => {
    const pidFile = join(mkdtempSync(join(tmpdir(), "monitor-pid-")), "pid");
    const { harness, stopAll } = await runCalls([fauxToolCall("monitor", { command: `echo $$ > ${pidFile}; exec sleep 30`, description: "sleeper" })]);
    try {
      await until(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the pid file");
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      stopAll();
      await until(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      }, "the command to stop");
    } finally {
      stopAll();
      await harness.close(context);
    }
  });

  it("refuses to start when the config is invalid", async () => {
    const { resultText, harness } = await runCalls([fauxToolCall("monitor", { command: "true", description: "x" })], {
      loadConfig: () => ({ errors: ["monitor.json: /batchMs too small"] }),
    });
    try {
      assert.match(resultText, /config is invalid/);
    } finally {
      await harness.close(context);
    }
  });
});
