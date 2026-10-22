import { LineBatcher, realTimers, type Timers } from "./batcher.ts";
import type { MonitorConfig } from "./config.ts";
import { LineSplitter, stripControlCharacters, truncateLine } from "./lines.ts";
import { formatBatch, formatEnd, type EndKind } from "./messages.ts";
import { RateLimiter } from "./rate-limiter.ts";
import type { MonitorRegistry, MonitorTask } from "./registry.ts";
import { startMonitorProcess, type MonitorExit } from "./run.ts";

const KEPT_LAST_LINES = 10;

export interface LaunchRequest {
  registry: MonitorRegistry;
  command: string;
  description: string;
  cwd: string;
  shell: { path: string; args: string[] };
  config: MonitorConfig;
  filter: (line: string) => boolean;
  includeStderr: boolean;
  /** Hands text to the model. It starts a turn without the user. */
  send: (text: string, task: MonitorTask) => void;
  /** Replaced in tests. */
  start?: typeof startMonitorProcess;
  timers?: Timers;
  now?: () => number;
}

export type LaunchResult = { task: MonitorTask } | { refusal: string };

function describeExit(exit: MonitorExit): { kind: EndKind; reason: string } {
  if (exit.startError !== undefined) return { kind: "failed", reason: `it could not start: ${exit.startError}` };
  if (exit.signal !== undefined) return { kind: "failed", reason: `signal ${exit.signal}` };
  if (exit.exitCode === 0) return { kind: "exited", reason: "exit code 0" };
  return { kind: "failed", reason: `exit code ${exit.exitCode}` };
}

/**
 * Starts the command and wires its output to the model.
 * Whoever ends the monitor first wins: the user (`registry.cancel`), the rate limit, the time limit or the command itself.
 * Only the command and the two limits send a message. The caller tells the model about a cancel.
 */
export function launchMonitor(request: LaunchRequest): LaunchResult {
  const { registry, config } = request;
  const timers = request.timers ?? realTimers;
  const now = request.now ?? Date.now;
  const start = request.start ?? startMonitorProcess;

  let process: ReturnType<typeof startMonitorProcess> | undefined;
  const started = registry.start({
    description: request.description,
    command: request.command,
    kill: () => {
      // A command whose group outlives its shell may never close, so the timer must not wait for `close`.
      timers.clear(timeout);
      process?.kill();
    },
  });
  if ("refusal" in started) return started;
  const { task } = started;

  const isRunning = () => registry.list().some((candidate) => candidate.id === task.id && candidate.status === "running");
  const currentTask = () => registry.list().find((candidate) => candidate.id === task.id) ?? task;
  const lastLines: string[] = [];
  const limiter = new RateLimiter(config.maxEventsPerMinute, now);
  const batcher = new LineBatcher({
    batchMs: config.batchMs,
    timers,
    onBatch: (lines) => {
      if (isRunning()) request.send(formatBatch(currentTask(), lines), currentTask());
    },
  });

  function stopWith(kind: "limited" | "timed-out", reason: string): void {
    if (!registry.finish(task.id, kind, reason)) return;
    batcher.discard();
    timers.clear(timeout);
    process?.kill();
    request.send(formatEnd({ task: currentTask(), kind, lastLines: [...lastLines], reason }), currentTask());
  }

  function handleLine(stream: "stdout" | "stderr", line: string): void {
    if (!isRunning()) return;
    line = stripControlCharacters(line);
    lastLines.push(truncateLine(line, config.maxLineChars));
    if (lastLines.length > KEPT_LAST_LINES) lastLines.shift();
    if (stream === "stderr" && !request.includeStderr) return;
    if (!request.filter(line)) return;
    if (limiter.record()) {
      stopWith("limited", `more than ${config.maxEventsPerMinute} lines in one minute`);
      return;
    }
    batcher.add(truncateLine(line, config.maxLineChars));
  }

  const splitters = { stdout: new LineSplitter(config.maxLineChars), stderr: new LineSplitter(config.maxLineChars) };
  const timeout = timers.set(() => stopWith("timed-out", `it ran for more than ${config.maxRuntimeMs} ms`), config.maxRuntimeMs);

  try {
    process = start({
      command: request.command,
      cwd: request.cwd,
      shell: request.shell,
      onData: (stream, chunk) => {
        for (const line of splitters[stream].push(chunk)) handleLine(stream, line);
      },
    });
  } catch (error) {
    // spawn throws at once for an argument it rejects, for example a NUL in the command.
    const reason = error instanceof Error ? error.message : String(error);
    timers.clear(timeout);
    registry.finish(task.id, "failed", reason);
    return { refusal: `The command could not start: ${reason}` };
  }

  void process.done.then((exit) => {
    timers.clear(timeout);
    for (const stream of ["stdout", "stderr"] as const) {
      for (const line of splitters[stream].flush()) handleLine(stream, line);
    }
    if (!isRunning()) {
      batcher.discard();
      return;
    }
    batcher.flush();
    const { kind, reason } = describeExit(exit);
    if (!registry.finish(task.id, kind === "exited" ? "exited" : "failed", reason)) return;
    request.send(formatEnd({ task: currentTask(), kind, lastLines: [...lastLines], reason }), currentTask());
  });

  return { task };
}
