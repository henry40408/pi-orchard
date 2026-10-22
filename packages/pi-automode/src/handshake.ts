import type { AutomodeStatus } from "./state.ts";

/** pi-automode emits its status here, on session start and whenever it is asked. */
export const STATUS_CHANNEL = "automode:status";
/** Another extension, such as pi-subagent, emits here to ask for the status. */
export const QUERY_CHANNEL = "automode:query";

/**
 * What goes over STATUS_CHANNEL. `entry` is the file that pi loads for this
 * extension: a child pi started with `--no-extensions -e <entry>` is guarded
 * by automode for sure. pi-subagent reads this shape; keep the two in step.
 */
export interface StatusMessage extends AutomodeStatus {
  entry: string;
  /** The log file of this session. A child writes to it too (see LOG_FILE_ENV in log.ts). */
  logFile?: string;
  /** The classifier model set in the config. Unset means the model of the session. A child is checked by it (see CLASSIFIER_MODEL_ENV in model.ts). */
  classifierModel?: string;
}

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export function announceStatus(events: EventBus, message: StatusMessage): void {
  events.emit(STATUS_CHANNEL, message);
}

/** Answers every query with the current status. Returns the unsubscribe function. */
export function answerQueries(events: EventBus, currentMessage: () => StatusMessage): () => void {
  return events.on(QUERY_CHANNEL, () => announceStatus(events, currentMessage()));
}
