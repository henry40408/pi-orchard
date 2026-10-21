/** pi-automode answers this channel with its status. The shape is defined by pi-automode (`StatusMessage`). */
export const STATUS_CHANNEL = "automode:status";
export const QUERY_CHANNEL = "automode:query";
/** The child's automode never runs looser than this mode. Defined by pi-automode. */
export const PARENT_MODE_ENV = "PI_AUTOMODE_PARENT_MODE";

const MODES = ["auto", "rules", "ask", "off"];

export type GuardPlan =
  /** pi-automode is not installed, so there is nothing to carry over. */
  | { kind: "none" }
  /** The child must load automode from `entry` and may not be looser than `mode`. */
  | { kind: "guarded"; entry: string; mode: string }
  /** pi-automode answered, but the answer is unusable. The child is not started. */
  | { kind: "invalid" };

interface EventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

/**
 * Asks pi-automode for its status. pi calls event handlers in the same tick,
 * so a reply, if there is one, has arrived when `emit` returns.
 */
export function queryGuard(events: EventBus): GuardPlan {
  const replies: unknown[] = [];
  const stop = events.on(STATUS_CHANNEL, (data) => replies.push(data));
  try {
    events.emit(QUERY_CHANNEL, undefined);
  } finally {
    stop();
  }
  if (replies.length === 0) return { kind: "none" };
  return planFromReply(replies[replies.length - 1]);
}

function planFromReply(reply: unknown): GuardPlan {
  if (typeof reply !== "object" || reply === null) return { kind: "invalid" };
  const { mode, entry } = reply as { mode?: unknown; entry?: unknown };
  if (typeof mode !== "string" || !MODES.includes(mode)) return { kind: "invalid" };
  if (typeof entry !== "string" || entry === "") return { kind: "invalid" };
  return { kind: "guarded", entry, mode };
}
