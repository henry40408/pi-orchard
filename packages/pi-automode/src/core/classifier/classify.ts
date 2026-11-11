import { randomUUID } from "node:crypto";
import type { ConversationContext } from "./context.ts";
import { parseAnswer, type ClassifierAnswer } from "./parse.ts";
import { buildPrompt, MAX_ACTION_CHARACTERS, serializeAction, type ClassifierRules, type Prompt } from "./prompt.ts";

/** Sends the prompt to a model and returns its reply. The caller picks the model and the auth. */
export type CompleteFn = (request: Prompt & { signal: AbortSignal }) => Promise<string>;

export interface ClassifyRequest {
  complete: CompleteFn;
  rules: ClassifierRules;
  conversation: ConversationContext;
  toolName: string;
  input: unknown;
  timeoutMs: number;
  /** Aborts the call when the agent turn is cancelled. */
  signal?: AbortSignal;
  /** Fixed in tests; random otherwise. */
  boundary?: string;
}

export interface ClassifierVerdict {
  /** `ask` is also what any failure ends in: the user decides when the classifier cannot. */
  decision: "allow" | "ask" | "deny";
  reason: string;
}

const VERDICTS: Record<ClassifierAnswer, ClassifierVerdict["decision"]> = {
  allow: "allow",
  soft_deny: "ask",
  hard_deny: "deny",
};

// complete() may ignore the signal, so the timer also rejects on its own.
async function completeWithin(request: ClassifyRequest, prompt: Prompt): Promise<string> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  request.signal?.addEventListener("abort", cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting also rejects, with a less useful message.
      reject(new Error(`timed out after ${request.timeoutMs} ms`));
      controller.abort();
    }, request.timeoutMs);
    controller.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
  });
  try {
    return await Promise.race([request.complete({ ...prompt, signal: controller.signal }), stop]);
  } finally {
    clearTimeout(timer);
    request.signal?.removeEventListener("abort", cancel);
  }
}

/** Asks the model whether a tool call may run. Never throws; a failure becomes `ask`. */
export async function classify(request: ClassifyRequest): Promise<ClassifierVerdict> {
  const { rules, conversation, toolName, input, boundary = randomUUID() } = request;
  try {
    // The model must see the whole action; a hidden middle could hold anything.
    if (serializeAction(toolName, input).length > MAX_ACTION_CHARACTERS) {
      return { decision: "ask", reason: "The action is too long for the classifier to review." };
    }
    if (request.signal?.aborted) return { decision: "ask", reason: "The classifier was cancelled." };
    const reply = await completeWithin(request, buildPrompt({ rules, conversation, toolName, input, boundary }));
    const answer = parseAnswer(reply);
    if (!answer) return { decision: "ask", reason: "The classifier gave an answer that could not be read." };
    return { decision: VERDICTS[answer.decision], reason: answer.reason };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { decision: "ask", reason: `The classifier failed: ${message}` };
  }
}
