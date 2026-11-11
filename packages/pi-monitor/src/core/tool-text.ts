/** What the model reads about the tools. The pi and the durable adapters share it, so the model gets the same text. */
export const MONITOR_TEXT = {
  tool:
    "Run a long-lived shell command in the background and get each batch of its output lines as a new message, which wakes you. " +
    "Use it to wait for an event without polling, for example a log line, a build result or a file change. " +
    "The command is stopped when it ends, when it prints too many lines, when it runs too long, or when the user cancels it. " +
    "Filter in the command or with include/exclude: every line that reaches you costs a turn.",
  command:
    "A shell command that keeps running and prints one line per event, for example `tail -f app.log | grep --line-buffered ERROR`. " +
    "Use `--line-buffered` (grep) or an equivalent when you pipe, or the lines arrive late.",
  description: "A short phrase that says what you watch for. It is shown in lists and in every message.",
  include: "Regex. Only lines that match are sent to you.",
  exclude: "Regex. Lines that match are not sent to you.",
  includeStderr: "Also send what the command prints on stderr. Default: false.",
  list: "List the monitors of this session and their status.",
  cancel: "Stop a running monitor. No more output arrives for it.",
  id: "The id of a monitor, such as mon-1.",
} as const;

export function describeList(tasks: readonly { id: string; status: string; description: string }[]): string {
  if (tasks.length === 0) return "No monitors in this session.";
  return tasks.map((task) => `${task.id}  ${task.status}  ${task.description}`).join("\n");
}
