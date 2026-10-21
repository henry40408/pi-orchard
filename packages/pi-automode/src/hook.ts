import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { classify, type CompleteFn } from "./classifier/classify.ts";
import { collectConversation, type ContextEntry } from "./classifier/context.ts";
import { classifierRules } from "./classifier/defaults.ts";
import type { Config } from "./config/schema.ts";
import { decide, type Outcome } from "./decide.ts";
import type { DecisionHistory, UserAnswer } from "./history.ts";
import { createPathContext } from "./permissions/paths.ts";
import type { AutomodeState } from "./state.ts";

/** The part of pi's extension context that the hook reads. */
export interface HookContext {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  ui: { confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean> };
  sessionManager: { getBranch(): readonly ContextEntry[] };
}

export interface HookDependencies<Context extends HookContext> {
  state: AutomodeState;
  completeFor: (context: Context, classifier: Config["classifier"]) => CompleteFn;
  /** Every decision is recorded here, for `/automode why`. */
  history?: DecisionHistory;
}

type ToolCall = Pick<ToolCallEvent, "toolName" | "input">;

// In a child pi the only user message is the task text, written by the parent
// agent. A prompt-injected parent could claim the user agreed to anything, so
// it is not offered to the classifier as what the user asked for.
function conversationFor(state: AutomodeState, context: HookContext, config: Config) {
  const conversation = collectConversation(context.sessionManager.getBranch(), config.classifier.context);
  return state.isChild ? { ...conversation, userMessages: [] } : conversation;
}

// The whole input is shown: a cut-off could hide the part that matters.
function describeCall(event: ToolCall): string {
  return `${event.toolName} ${JSON.stringify(event.input, null, 2) ?? ""}`;
}

interface Resolution {
  result: ToolCallEventResult | undefined;
  /** Set only when the outcome was `ask`. */
  answer?: UserAnswer;
}

async function askUser(context: HookContext, event: ToolCall, outcome: Outcome): Promise<Resolution> {
  if (!context.hasUI) {
    return { result: { block: true, reason: `${outcome.reason}, and there is no user to ask` }, answer: "no-ui" };
  }
  const allowed = await context.ui.confirm("Allow this tool call?", `${describeCall(event)}\n\nWhy automode asks: ${outcome.reason}`, {
    signal: context.signal,
  });
  if (allowed) return { result: undefined, answer: "allowed" };
  return { result: { block: true, reason: "The user did not allow this tool call" }, answer: "denied" };
}

async function resolve(context: HookContext, event: ToolCall, outcome: Outcome): Promise<Resolution> {
  if (outcome.action === "allow") return { result: undefined };
  if (outcome.action === "block") return { result: { block: true, reason: outcome.reason } };
  return askUser(context, event, outcome);
}

/**
 * The `tool_call` handler. It returns nothing to let the call run, or a block
 * with a reason that the model sees. Any unexpected error asks the user.
 */
export function createToolCallHandler<Context extends HookContext>(dependencies: HookDependencies<Context>) {
  return async (event: ToolCall, context: Context): Promise<ToolCallEventResult | undefined> => {
    let outcome: Outcome;
    try {
      const config = dependencies.state.config(context.cwd);
      outcome = await decide({
        config,
        toolName: event.toolName,
        input: event.input,
        pathContext: createPathContext(context.cwd),
        classifyAction: () =>
          classify({
            complete: dependencies.completeFor(context, config.classifier),
            rules: classifierRules(config.classifier),
            conversation: conversationFor(dependencies.state, context, config),
            toolName: event.toolName,
            input: event.input,
            timeoutMs: config.classifier.timeoutMs,
            signal: context.signal,
          }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { action: "ask", source: "fallback", reason: `automode failed: ${message}` };
    }

    const history = dependencies.history;
    try {
      const { result, answer } = await resolve(context, event, outcome);
      history?.record({ toolName: event.toolName, input: event.input, outcome, answer });
      return result;
    } catch (error) {
      // The user's confirm failed (say, it was aborted): keep the trace, then fail as before.
      history?.record({ toolName: event.toolName, input: event.input, outcome, answer: "denied" });
      throw error;
    }
  };
}
