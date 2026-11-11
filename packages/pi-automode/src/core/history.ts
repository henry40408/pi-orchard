import type { Outcome } from "./decide.ts";

/** What the user did when automode asked. `no-ui` means there was nobody to ask. */
export type UserAnswer = "allowed" | "denied" | "no-ui";

export interface DecisionRecord {
  time: Date;
  toolName: string;
  /** One line, cut short: for display only. */
  summary: string;
  outcome: Outcome;
  answer?: UserAnswer;
  /** Set when the decision was made by a subagent. Only the log knows this. */
  child?: boolean;
}

const MAX_SUMMARY_LENGTH = 80;

// A circular or BigInt input must not make the history throw into the hook.
function safeStringify(input: unknown): string {
  try {
    return JSON.stringify(input) ?? "";
  } catch {
    return "(input cannot be shown)";
  }
}

export function summarizeInput(input: unknown): string {
  const text = safeStringify(input);
  const oneLine = text.replace(/\s+/g, " ");
  return oneLine.length > MAX_SUMMARY_LENGTH ? `${oneLine.slice(0, MAX_SUMMARY_LENGTH - 1)}…` : oneLine;
}

/** The most recent decisions of this session, kept in memory only. */
export class DecisionHistory {
  #capacity: number;
  #records: DecisionRecord[] = [];

  constructor(capacity = 50) {
    this.#capacity = capacity;
  }

  record(entry: Omit<DecisionRecord, "time" | "summary"> & { input: unknown }): DecisionRecord {
    const { input, ...rest } = entry;
    const record: DecisionRecord = { ...rest, time: new Date(), summary: summarizeInput(input) };
    this.#records.push(record);
    if (this.#records.length > this.#capacity) this.#records.shift();
    return record;
  }

  /** Newest last. */
  recent(count: number): DecisionRecord[] {
    return count <= 0 ? [] : this.#records.slice(-count);
  }
}
