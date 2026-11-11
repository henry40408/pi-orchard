import { ToolResultEntry, UserEntry, type EntryRecord } from "@earendil-works/pi-durable";
import type { ContextEntry } from "../core/classifier/context.ts";

/**
 * Durable keeps the messages of an entry in `model`; the classifier reads pi's session shape, so each message
 * becomes one `message` entry. `records` must be oldest first.
 *
 * Only what a person typed and what tools returned is kept. Other entries also hold `role: "user"` messages
 * (a compaction summary, a handoff, an `onYield` continuation) that a model or an extension wrote, and the
 * classifier must not read those as the user's consent.
 */
export function toContextEntries(records: readonly EntryRecord[]): ContextEntry[] {
  return records
    .filter((record) => UserEntry.is(record) || ToolResultEntry.is(record))
    .flatMap((record) =>
      (record.model ?? []).map((message): ContextEntry => ({ type: "message", message: message as NonNullable<ContextEntry["message"]> })),
    );
}
