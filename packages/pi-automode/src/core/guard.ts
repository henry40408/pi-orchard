import { classify, type CompleteFn } from "./classifier/classify.ts";
import { collectConversation, type ContextEntry } from "./classifier/context.ts";
import { classifierRules } from "./classifier/defaults.ts";
import type { Config } from "./config/schema.ts";
import { decide, type Outcome } from "./decide.ts";
import type { DecisionHistory, UserAnswer } from "./history.ts";
import type { DecisionLog, LogEntry } from "./log.ts";
import { createPathContext } from "./permissions/paths.ts";
import type { AutomodeState } from "./state.ts";

/** A tool call to judge, in the terms of no host: each adapter fills it from its own event. */
export interface GuardCall {
  toolName: string;
  input: unknown;
  cwd: string;
  signal?: AbortSignal;
  /**
   * False when the "user" messages come from another agent, as in a subagent: they are then not offered to the
   * classifier as what the user asked for. Default: true.
   */
  trustUserMessages?: boolean;
  /** The current branch of the conversation, oldest first. Read only when the classifier runs. */
  entries: () => readonly ContextEntry[] | Promise<readonly ContextEntry[]>;
}

export interface GuardDependencies {
  state: AutomodeState;
  completeFor: (classifier: Config["classifier"]) => CompleteFn;
  /** Every decision is recorded here, for `/automode why`. */
  history?: DecisionHistory;
  /** The log file of the current session, if there is one. Asked on every call: a new session has a new file. */
  currentLog?: () => DecisionLog | undefined;
}

type ClassifierExchange = NonNullable<LogEntry["classifier"]>;

export interface Judgement {
  outcome: Outcome;
  /** What the classifier was asked and said. Set only when it ran. */
  exchange?: ClassifierExchange;
}

// `complete` has its own timeout inside `classify`; reading the history must not wait for ever either.
function withinTimeout<T>(work: Promise<T> | T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`reading the conversation timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(work), expired]).finally(() => clearTimeout(timer));
}

// In a child pi the only user message is the task text, written by the parent
// agent. A prompt-injected parent could claim the user agreed to anything, so
// it is not offered to the classifier as what the user asked for.
async function conversationFor(state: AutomodeState, call: GuardCall, config: Config) {
  const entries = await withinTimeout(call.entries(), config.classifier.timeoutMs);
  const conversation = collectConversation(entries, config.classifier.context);
  const userMessagesAreTrusted = !state.isChild && call.trustUserMessages !== false;
  return userMessagesAreTrusted ? conversation : { ...conversation, userMessages: [] };
}

/** The whole input is shown: a cut-off could hide the part that matters. */
export function describeCall(call: Pick<GuardCall, "toolName" | "input">): string {
  return `${call.toolName} ${JSON.stringify(call.input, null, 2) ?? ""}`;
}

/** Decides what to do with a call. Never throws: an unexpected error becomes `ask`. */
export async function judgeToolCall(dependencies: GuardDependencies, call: GuardCall): Promise<Judgement> {
  let liveExchange: ClassifierExchange | undefined;
  try {
    const config = dependencies.state.config(call.cwd);
    // Noted only for the log; the log decides later whether to write it.
    const noteExchange = (complete: CompleteFn): CompleteFn => async (request) => {
      const reply = await complete(request);
      liveExchange = { system: request.system, user: request.user, reply };
      return reply;
    };
    const pickComplete = (): CompleteFn => {
      const complete = dependencies.completeFor(config.classifier);
      return config.log.enabled && config.log.classifierIo ? noteExchange(complete) : complete;
    };
    const outcome = await decide({
      config,
      toolName: call.toolName,
      input: call.input,
      pathContext: createPathContext(call.cwd),
      classifyAction: async () =>
        classify({
          complete: pickComplete(),
          rules: classifierRules(config.classifier),
          conversation: await conversationFor(dependencies.state, call, config),
          toolName: call.toolName,
          input: call.input,
          timeoutMs: config.classifier.timeoutMs,
          signal: call.signal,
        }),
    });
    // Taken when `decide` returns: a reply that arrives after a timeout belongs to no decision.
    return { outcome, exchange: liveExchange };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { outcome: { action: "ask", source: "fallback", reason: `automode failed: ${message}` } };
  }
}

/** Writes the decision to the history and, when `log.enabled`, to the log. Nothing here may throw. */
export function recordDecision(
  dependencies: GuardDependencies,
  record: { call: GuardCall; judgement: Judgement; answer?: UserAnswer },
): void {
  const { call, judgement, answer } = record;
  const { outcome, exchange } = judgement;
  dependencies.history?.record({ toolName: call.toolName, input: call.input, outcome, answer });
  try {
    const log = dependencies.currentLog?.();
    if (!log) return;
    const { log: settings } = dependencies.state.config(call.cwd);
    if (!settings.enabled) return;
    log.write(
      {
        cwd: call.cwd,
        toolName: call.toolName,
        input: call.input,
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
