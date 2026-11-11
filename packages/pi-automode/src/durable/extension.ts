import { defineExtension, hook, ToolTask, type Extension, type HookApi } from "@earendil-works/pi-durable";
import type { CompleteFn } from "../core/classifier/classify.ts";
import type { Config } from "../core/config/schema.ts";
import { judgeToolCall, recordDecision, type GuardDependencies } from "../core/guard.ts";
import { toContextEntries } from "./entries.ts";

export const EXTENSION_NAME = "automode";

/** The newest entries read for the classifier. Its own token budget cuts the list further. */
const MAX_ENTRIES_READ = 200;

export interface AutomodeExtensionOptions extends Omit<GuardDependencies, "completeFor"> {
  /** The working directory the rules are checked in. A durable hook does not know it, so the host passes it. */
  cwd: string;
  /**
   * Whether the conversation talks to a person. In any other (a subagent), the "user" messages come from the parent
   * model, so they are not offered to the classifier as what the user asked for. Required: the safe answer is the
   * host's to give, since a hook cannot tell who owns a conversation.
   */
  isRootConversation: (conversationId: HookApi["conversationId"]) => boolean;
  /** Builds the function that sends the classifier prompt to a model. The host owns models and auth. */
  completeFor: (classifier: Config["classifier"]) => CompleteFn;
}

/**
 * Checks every tool call of the conversations that select this extension, as the pi extension does.
 * A call that needs a question is blocked: this version of durable cannot park a call for an answer.
 *
 * Install it after every extension that rewrites tool arguments: durable lets a later `beforeTool` hook replace
 * the arguments of an earlier one, and the call must run with the arguments that were judged.
 */
export function createAutomodeExtension(options: AutomodeExtensionOptions): Extension {
  const { cwd, isRootConversation, ...dependencies } = options;
  return defineExtension({
    name: EXTENSION_NAME,
    hooks: [
      hook(ToolTask, {
        beforeTool: async (toolCall, api, context) => {
          const call = {
            toolName: toolCall.name,
            input: toolCall.arguments,
            cwd,
            signal: context.abortSignal,
            trustUserMessages: isRootConversation(api.conversationId),
            entries: async () => {
              const { items } = await api.entries({}, MAX_ENTRIES_READ, undefined, context);
              // The query returns the newest first.
              return toContextEntries([...items].reverse());
            },
          };
          const judgement = await judgeToolCall(dependencies, call);
          const { outcome } = judgement;
          const asked = outcome.action === "ask";
          recordDecision(dependencies, { call, judgement, answer: asked ? "no-ui" : undefined });
          if (outcome.action === "allow") return undefined;
          return { block: asked ? `${outcome.reason}, and there is no user to ask` : outcome.reason };
        },
      }),
    ],
  });
}
