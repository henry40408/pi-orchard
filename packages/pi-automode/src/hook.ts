import type { ToolCallEvent, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { classify, type CompleteFn } from "./classifier/classify.ts";
import { collectConversation, type ContextEntry } from "./classifier/context.ts";
import { classifierRules } from "./classifier/defaults.ts";
import type { Config } from "./config/schema.ts";
import { decide, type Outcome } from "./decide.ts";
import type { DecisionHistory, UserAnswer } from "./history.ts";
import type { DecisionLog, LogEntry } from "./log.ts";
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
  /** The log file of the current session, if there is one. Asked on every call: a new session has a new file. */
  currentLog?: () => DecisionLog | undefined;
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

type ClassifierExchange = NonNullable<LogEntry["classifier"]>;

/** Writes the decision to the log when `log.enabled`. Nothing here may throw into the hook. */
function writeToLog<Context extends HookContext>(
  dependencies: HookDependencies<Context>,
  record: { context: Context; event: ToolCall; outcome: Outcome; answer?: UserAnswer; exchange?: ClassifierExchange },
): void {
  try {
    const log = dependencies.currentLog?.();
    if (!log) return;
    const { context, event, outcome, answer, exchange } = record;
    const { log: settings } = dependencies.state.config(context.cwd);
    if (!settings.enabled) return;
    log.write(
      {
        cwd: context.cwd,
        toolName: event.toolName,
        input: event.input,
        action: outcome.action,
        source: outcome.source,
        reason: outcome.reason,
        answer,
        child: dependencies.state.isChild,
        classifier: settings.classifierIo ? exchange : undefined,
      },
      settings,
    );
  } catch {
    // A broken log must never change what happens to the tool call.
  }
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
    let liveExchange: ClassifierExchange | undefined;
    // Taken when `decide` returns: a reply that arrives after a timeout belongs to no decision.
    let exchange: ClassifierExchange | undefined;
    try {
      const config = dependencies.state.config(context.cwd);
      // Noted only for the log; the log decides later whether to write it.
      const noteExchange = (complete: CompleteFn): CompleteFn => async (request) => {
        const reply = await complete(request);
        liveExchange = { system: request.system, user: request.user, reply };
        return reply;
      };
      const pickComplete = (): CompleteFn => {
        const complete = dependencies.completeFor(context, config.classifier);
        return config.log.enabled && config.log.classifierIo ? noteExchange(complete) : complete;
      };
      outcome = await decide({
        config,
        toolName: event.toolName,
        input: event.input,
        pathContext: createPathContext(context.cwd),
        classifyAction: () =>
          classify({
            complete: pickComplete(),
            rules: classifierRules(config.classifier),
            conversation: conversationFor(dependencies.state, context, config),
            toolName: event.toolName,
            input: event.input,
            timeoutMs: config.classifier.timeoutMs,
            signal: context.signal,
          }),
      });
      exchange = liveExchange;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      outcome = { action: "ask", source: "fallback", reason: `automode failed: ${message}` };
    }

    const history = dependencies.history;
    try {
      const { result, answer } = await resolve(context, event, outcome);
      history?.record({ toolName: event.toolName, input: event.input, outcome, answer });
      writeToLog(dependencies, { context, event, outcome, answer, exchange });
      return result;
    } catch (error) {
      // The user's confirm failed (say, it was aborted): keep the trace, then fail as before.
      history?.record({ toolName: event.toolName, input: event.input, outcome, answer: "denied" });
      writeToLog(dependencies, { context, event, outcome, answer: "denied", exchange });
      throw error;
    }
  };
}
