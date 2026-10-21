import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { classify, type CompleteFn } from "./classifier/classify.ts";
import { collectConversation, type ContextEntry } from "./classifier/context.ts";
import { classifierRules } from "./classifier/defaults.ts";
import type { Config } from "./config/schema.ts";
import { decide, type Outcome } from "./decide.ts";
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
}

type ToolCall = Pick<ToolCallEvent, "toolName" | "input">;

// The whole input is shown: a cut-off could hide the part that matters.
function describeCall(event: ToolCall): string {
  return `${event.toolName} ${JSON.stringify(event.input, null, 2) ?? ""}`;
}

async function askUser(context: HookContext, event: ToolCall, outcome: Outcome): Promise<ToolCallEventResult | undefined> {
  if (!context.hasUI) return { block: true, reason: `${outcome.reason}, and there is no user to ask` };
  const allowed = await context.ui.confirm("Allow this tool call?", `${describeCall(event)}\n\nWhy automode asks: ${outcome.reason}`, {
    signal: context.signal,
  });
  return allowed ? undefined : { block: true, reason: "The user did not allow this tool call" };
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
            conversation: collectConversation(context.sessionManager.getBranch(), config.classifier.context),
            toolName: event.toolName,
            input: event.input,
            timeoutMs: config.classifier.timeoutMs,
            signal: context.signal,
          }),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { action: "ask", reason: `automode failed: ${message}` };
    }

    if (outcome.action === "allow") return undefined;
    if (outcome.action === "block") return { block: true, reason: outcome.reason };
    return askUser(context, event, outcome);
  };
}
