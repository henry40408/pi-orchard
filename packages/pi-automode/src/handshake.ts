import type { AutomodeStatus } from "./state.ts";

/** pi-automode emits its status here, on session start and whenever it is asked. */
export const STATUS_CHANNEL = "automode:status";
/** Another extension, such as pi-subagent, emits here to ask for the status. */
export const QUERY_CHANNEL = "automode:query";

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export function announceStatus(events: EventBus, status: AutomodeStatus): void {
  events.emit(STATUS_CHANNEL, status);
}

/** Answers every query with the current status. Returns the unsubscribe function. */
export function answerQueries(events: EventBus, currentStatus: () => AutomodeStatus): () => void {
  return events.on(QUERY_CHANNEL, () => announceStatus(events, currentStatus()));
}
