import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import type { ContextEntry } from "../core/classifier/context.ts";
import type { Config } from "../core/config/schema.ts";
import type { Outcome } from "../core/decide.ts";
import { describeCall, judgeToolCall, recordDecision, type GuardCall, type GuardDependencies, type Judgement } from "../core/guard.ts";
import type { UserAnswer } from "../core/history.ts";
import type { CompleteFn } from "../core/classifier/classify.ts";

/** The part of pi's extension context that the hook reads. */
export interface HookContext {
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal | undefined;
  ui: { confirm(title: string, message: string, options?: { signal?: AbortSignal }): Promise<boolean> };
  sessionManager: { getBranch(): readonly ContextEntry[] };
}

export interface HookDependencies<Context extends HookContext> extends Omit<GuardDependencies, "completeFor"> {
  completeFor: (context: Context, classifier: Config["classifier"]) => CompleteFn;
}

type ToolCall = Pick<ToolCallEvent, "toolName" | "input">;

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
    const guard: GuardDependencies = { ...dependencies, completeFor: (classifier) => dependencies.completeFor(context, classifier) };
    // Read on use, inside the guard's try: an error from pi's context must end in `ask`, not escape the handler.
    const call: GuardCall = {
      toolName: event.toolName,
      input: event.input,
      get cwd() {
        return context.cwd;
      },
      get signal() {
        return context.signal;
      },
      entries: () => context.sessionManager.getBranch(),
    };
    const judgement: Judgement = await judgeToolCall(guard, call);
    try {
      const { result, answer } = await resolve(context, event, judgement.outcome);
      recordDecision(guard, { call, judgement, answer });
      return result;
    } catch (error) {
      // The user's confirm failed (say, it was aborted): keep the trace, then fail as before.
      recordDecision(guard, { call, judgement, answer: "denied" });
      throw error;
    }
  };
}
