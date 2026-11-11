export type MonitorStatus = "running" | "exited" | "failed" | "cancelled" | "limited" | "timed-out";

export interface MonitorTask {
  id: string;
  /** What the model said it watches, for lists. */
  description: string;
  command: string;
  status: MonitorStatus;
  startedAt: number;
  finishedAt?: number;
  /** Why the monitor ended, when the status alone does not say. */
  detail?: string;
}

export interface StartRequest {
  description: string;
  command: string;
  /** Stops the process. The registry calls it for `cancel` and `cancelAll`. */
  kill: () => void;
}

export type StartResult = { task: MonitorTask } | { refusal: string };

const MAX_DESCRIPTION_CHARS = 80;
const DEFAULT_KEPT_FINISHED = 20;

interface Entry {
  task: MonitorTask;
  kill: () => void;
}

/** The monitors of this session, kept in memory only. */
export class MonitorRegistry {
  #maxRunning: number;
  #keptFinished: number;
  #now: () => number;
  #onChange: (runningCount: number) => void;
  #entries: Entry[] = [];
  #counter = 0;

  constructor(options: {
    maxRunning: number;
    keptFinished?: number;
    now?: () => number;
    /** Called after the number of running monitors may have changed. */
    onChange?: (runningCount: number) => void;
  }) {
    this.#maxRunning = options.maxRunning;
    this.#keptFinished = options.keptFinished ?? DEFAULT_KEPT_FINISHED;
    this.#now = options.now ?? Date.now;
    this.#onChange = options.onChange ?? (() => {});
  }

  /** The limit may change between calls, because the config is read again for each call. */
  setMaxRunning(maxRunning: number): void {
    this.#maxRunning = maxRunning;
  }

  start(request: StartRequest): StartResult {
    const running = this.#runningCount();
    if (running >= this.#maxRunning) {
      return { refusal: `${running} monitors are already running (the limit is ${this.#maxRunning}). Cancel one, or wait for one to end.` };
    }
    this.#counter += 1;
    const oneLine = request.description.replace(/\s+/g, " ").trim();
    const description = oneLine.length > MAX_DESCRIPTION_CHARS ? `${oneLine.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : oneLine;
    const task: MonitorTask = { id: `mon-${this.#counter}`, description, command: request.command, status: "running", startedAt: this.#now() };
    this.#entries.push({ task, kill: request.kill });
    this.#notifyChange();
    return { task: { ...task } };
  }

  /** Marks a running monitor as ended. Returns false when it was not running, so the first reason wins. */
  finish(id: string, status: Exclude<MonitorStatus, "running">, detail?: string): boolean {
    const entry = this.#entries.find((candidate) => candidate.task.id === id);
    if (!entry || entry.task.status !== "running") return false;
    entry.task.status = status;
    entry.task.finishedAt = this.#now();
    if (detail !== undefined) entry.task.detail = detail;
    this.#dropOldFinished();
    this.#notifyChange();
    return true;
  }

  /** Oldest first. */
  list(): MonitorTask[] {
    return this.#entries.map((entry) => ({ ...entry.task }));
  }

  /** Returns a message when nothing was cancelled. */
  cancel(id: string): string | undefined {
    const entry = this.#entries.find((candidate) => candidate.task.id === id);
    if (!entry) return `There is no monitor ${id}.`;
    if (entry.task.status !== "running") return `${id} is not running (${entry.task.status}).`;
    this.#stop(entry);
    this.#notifyChange();
    return undefined;
  }

  /** The caller says why: the session ends, or the user asked. */
  cancelAll(): void {
    for (const entry of this.#entries) {
      if (entry.task.status === "running") this.#stop(entry);
    }
    this.#notifyChange();
  }

  #stop(entry: Entry): void {
    entry.task.status = "cancelled";
    entry.task.finishedAt = this.#now();
    try {
      entry.kill();
    } catch {
      // The process is gone already.
    }
  }

  #runningCount(): number {
    return this.#entries.filter((entry) => entry.task.status === "running").length;
  }

  #dropOldFinished(): void {
    const finished = this.#entries.filter((entry) => entry.task.status !== "running");
    const surplus = finished.length - this.#keptFinished;
    if (surplus <= 0) return;
    const dropped = new Set(finished.slice(0, surplus));
    this.#entries = this.#entries.filter((entry) => !dropped.has(entry));
  }

  #notifyChange(): void {
    try {
      this.#onChange(this.#runningCount());
    } catch {
      // A footer that cannot be drawn must not stop a monitor.
    }
  }
}
