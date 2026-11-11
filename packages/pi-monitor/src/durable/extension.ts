import { randomUUID } from "node:crypto";
import { defineExtension, defineTool, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import { bool, obj, opt, str } from "@earendil-works/pi-schema";
import type { LoadedMonitorConfig } from "../core/config.ts";
import { compileLineFilter } from "../core/lines.ts";
import { launchMonitor } from "../core/monitor.ts";
import { MonitorRegistry } from "../core/registry.ts";
import { describeList, MONITOR_TEXT } from "../core/tool-text.ts";
import { startEnvProcess } from "./process.ts";

export const EXTENSION_NAME = "monitor";

export interface DeliveryRequest {
  conversationId: ConversationId;
  /** Stable for one message, so storage drops a message that is sent twice. */
  requestId: string;
  text: string;
}

export interface MonitorExtensionOptions {
  /** Read on every call, so an edit applies at once. An invalid config stops the monitor. */
  loadConfig: () => LoadedMonitorConfig;
  /**
   * Hands text to the conversation that started the monitor, as a follow-up input. It starts a run when the
   * conversation is idle. A tool call cannot do this: it ends before the output arrives, so the host does it.
   */
  deliver: (request: DeliveryRequest) => Promise<void>;
  /** Told when `deliver` fails. Nothing else can report it: the command runs on without a caller. */
  onDeliveryError?: (error: unknown) => void;
}

export interface MonitorExtension {
  extension: Extension;
  /** Stops every running monitor. The host calls it before it closes the Harness. */
  stopAll: () => void;
}

const textResult = (text: string) => ({ output: [{ type: "text" as const, text }] });

/**
 * The `monitor`, `monitor_list` and `monitor_cancel` tools, as the pi extension offers them.
 * Each conversation has its own monitors, as each pi session does.
 * The monitors live in memory only: a restart of the host ends them, and the model is not told.
 */
export function createMonitorExtension(options: MonitorExtensionOptions): MonitorExtension {
  const registries = new Map<ConversationId, MonitorRegistry>();
  const registryOf = (conversationId: ConversationId): MonitorRegistry => {
    const existing = registries.get(conversationId);
    if (existing !== undefined) return existing;
    const created = new MonitorRegistry({ maxRunning: 1 });
    registries.set(conversationId, created);
    return created;
  };
  const reportDeliveryError = (error: unknown): void => {
    try {
      options.onDeliveryError?.(error);
    } catch {
      // A broken report must not stop the command.
    }
  };
  // A restart starts the ids at mon-1 again, and storage remembers the request ids of the earlier run.
  const runId = randomUUID();

  const monitor = defineTool({
    name: "monitor",
    description: MONITOR_TEXT.tool,
    parameters: obj({
      command: str({ description: MONITOR_TEXT.command }),
      description: str({ description: MONITOR_TEXT.description }),
      include: opt(str({ description: MONITOR_TEXT.include })),
      exclude: opt(str({ description: MONITOR_TEXT.exclude })),
      includeStderr: opt(bool({ description: MONITOR_TEXT.includeStderr })),
    }),
    execute: async (args, api) => {
      const { env } = api;
      if (env === undefined) throw new Error("A monitor needs an execution environment.");
      const loaded = options.loadConfig();
      if ("errors" in loaded) throw new Error(`The monitor was not started because its config is invalid:\n${loaded.errors.join("\n")}`);
      const filter = compileLineFilter({ include: args.include, exclude: args.exclude });
      if ("error" in filter) throw new Error(filter.error);

      const registry = registryOf(api.conversationId);
      registry.setMaxRunning(loaded.config.maxMonitors);
      let sent = 0;
      const launched = launchMonitor({
        registry,
        command: args.command,
        description: args.description,
        config: loaded.config,
        filter,
        includeStderr: args.includeStderr ?? false,
        send: (text, task) => {
          sent += 1;
          const request = { conversationId: api.conversationId, requestId: `monitor:${runId}:${task.id}:${sent}`, text };
          // `send` runs in timers and callbacks of the command, where a throw would end the host.
          void Promise.resolve()
            .then(() => options.deliver(request))
            .catch(reportDeliveryError);
        },
        start: (run) => startEnvProcess(env, run),
      });
      if ("refusal" in launched) throw new Error(launched.refusal);
      return textResult(`Started monitor ${launched.task.id}. Its output will arrive later as new messages, and a last message when it ends.`);
    },
  });

  const monitorList = defineTool({
    name: "monitor_list",
    description: MONITOR_TEXT.list,
    parameters: obj({}),
    execute: async (_args, api) => textResult(describeList(registryOf(api.conversationId).list())),
  });

  const monitorCancel = defineTool({
    name: "monitor_cancel",
    description: MONITOR_TEXT.cancel,
    parameters: obj({ id: str({ description: MONITOR_TEXT.id }) }),
    execute: async (args, api) => {
      const problem = registryOf(api.conversationId).cancel(args.id);
      if (problem !== undefined) throw new Error(problem);
      return textResult(`Cancelled ${args.id}.`);
    },
  });

  return {
    extension: defineExtension({ name: EXTENSION_NAME, tools: [monitor, monitorList, monitorCancel] }),
    stopAll: () => {
      for (const registry of registries.values()) registry.cancelAll();
    },
  };
}
