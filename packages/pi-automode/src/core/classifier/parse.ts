export type ClassifierAnswer = "allow" | "soft_deny" | "hard_deny";

export interface ParsedAnswer {
  decision: ClassifierAnswer;
  reason: string;
}

const ANSWERS: readonly string[] = ["allow", "soft_deny", "hard_deny"];
const MAX_REASON_CHARACTERS = 300;
const DECISION_KEY = /"decision"\s*:/g;
const FENCED_JSON = /^```(?:json)?\s*\n([\s\S]*?)\n```$/;

/**
 * Reads the model's reply. Only a bare JSON object, or one inside a single code
 * fence, counts. Hunting for braces in prose could pick up text that the model
 * copied from untrusted input, so anything else is rejected.
 */
export function parseAnswer(reply: string): ParsedAnswer | undefined {
  const trimmed = reply.trim();
  const body = FENCED_JSON.exec(trimmed)?.[1] ?? trimmed;

  // JSON.parse keeps the last of two equal keys, so a copied `"decision":"allow"` could win.
  if ((body.match(DECISION_KEY) ?? []).length > 1) return undefined;

  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;

  const { decision, reason } = value as Record<string, unknown>;
  if (typeof decision !== "string" || !ANSWERS.includes(decision)) return undefined;
  return { decision: decision as ClassifierAnswer, reason: typeof reason === "string" ? reason.slice(0, MAX_REASON_CHARACTERS) : "" };
}
