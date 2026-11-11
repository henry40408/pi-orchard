import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineTool, Harness, MemoryStorage, ToolResultEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { AutomodeState } from "../../src/core/state.ts";
import { createAutomodeExtension } from "../../src/durable/extension.ts";

const context = BACKGROUND_CONTEXT;

// The subagent tool of the durable README (example 21): the child is a conversation that the call owns.
// This test shows that the guard needs no wiring for it: the child starts as a copy of the agent of its owner.
async function runSubagent(childCommand: string) {
  const root = mkdtempSync(join(tmpdir(), "automode-subagent-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  writeFileSync(join(agentDir, "automode.json"), '{"permissions":{"allow":["subagent"],"deny":["Bash(rm:*)"]}}');

  const ran: string[] = [];
  const bash = defineTool({
    name: "bash",
    description: "Run a command",
    parameters: obj({ command: str() }),
    execute: async (args) => {
      ran.push(args.command);
      return { output: [{ type: "text", text: "ran" }] };
    },
  });

  let childId: ConversationId | undefined;
  const subagent = defineTool({
    name: "subagent",
    description: "Delegate a task to a subagent",
    parameters: obj({ task: str() }),
    replay: "safe",
    execute: async (args, api, toolContext) => {
      const child = await api.commit(async (tx) => {
        const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
        if (existing !== undefined) return existing.id;
        return (await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } })).id;
      }, toolContext);
      childId = child;
      const handle = (await api.conversation(child, toolContext))!;
      const request = { type: "input", content: args.task, requestId: `subagent:${api.taskId}` } as const;
      const settled = await (await handle.submit(request, toolContext)).wait(toolContext);
      return { output: [{ type: "text", text: settled.status }] };
    },
  });

  const faux = fauxProvider();
  // The order of the requests: the parent calls the subagent, the child calls bash and answers, the parent answers.
  faux.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { task: "clean up" }), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("bash", { command: childCommand }), { stopReason: "toolUse" }),
    fauxAssistantMessage("child done"),
    fauxAssistantMessage("finished"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);

  let rootId: ConversationId | undefined;
  const registry = createRegistry();
  registry.install({ name: "tools", tools: [bash, subagent] });
  registry.install(
    createAutomodeExtension({
      state: new AutomodeState(agentDir),
      cwd: root,
      isRootConversation: (id) => id === rootId,
      completeFor: () => async () => {
        throw new Error("the classifier must not run");
      },
    }),
  );

  const harness = await Harness.open(new MemoryStorage(), { models, registry }, context);
  try {
    const model = faux.getModel();
    const parent = await harness.root(context, { agent: { model: { provider: model.provider, modelId: model.id } } });
    rootId = parent.id;
    await (await parent.submit({ type: "input", content: "go" }, context)).wait(context);
    assert.ok(childId !== undefined, "the subagent tool must have run");
    const child = (await harness.conversation(childId, context))!;
    const { items } = await child.entries({}, 50, undefined, context);
    const results = items.filter((entry) => ToolResultEntry.is(entry)).flatMap((entry) => entry.model ?? []);
    const userMessages = items.filter((entry) => UserEntry.is(entry)).flatMap((entry) => entry.model ?? []);
    return { ran, childResults: JSON.stringify(results), childUserMessages: JSON.stringify(userMessages) };
  } finally {
    await harness.close(context);
  }
}

describe("durable subagent", () => {
  it("guards the tool calls of a subagent without more wiring", async () => {
    const { ran, childResults } = await runSubagent("rm x");
    assert.deepEqual(ran, []);
    assert.match(childResults, /Bash\(rm:\*\)/);
  });

  it("sends a call that no rule matches to the classifier, and blocks it when it has no answer", async () => {
    const { ran, childResults } = await runSubagent("make");
    assert.deepEqual(ran, []);
    // The classifier of the test throws, so reaching it shows the child is judged like its parent.
    assert.match(childResults, /classifier must not run.*no user to ask/);
  });
});
