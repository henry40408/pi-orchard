export type BackgroundStatus = "running" | "done" | "failed" | "cancelled";

export interface BackgroundTask {
  id: string;
  /** The start of the task text, for lists. */
  summary: string;
  /** The whole task text, for the detail view. */
  task: string;
  status: BackgroundStatus;
  startedAt: number;
  finishedAt?: number;
  /** Why a failed task failed. */
  error?: string;
}

/** What a finished child produced: `error` is set when it failed. */
export interface BackgroundOutcome {
  text: string;
  error?: string;
}

export interface StartRequest {
  task: string;
  /** Runs the child. It must stop when the signal aborts. */
  run: (signal: AbortSignal) => Promise<BackgroundOutcome>;
  /** Called once when the child finished by itself. Not called after `cancel`. */
  onFinish: (task: BackgroundTask, outcome: BackgroundOutcome) => void;
}

export type StartResult = { task: BackgroundTask } | { refusal: string };

const MAX_SUMMARY_CHARS = 80;
const DEFAULT_KEPT_FINISHED = 20;

interface Entry {
  task: BackgroundTask;
  controller: AbortController;
}

/** The background subagents of this session, kept in memory only. */
export class BackgroundRegistry {
  #maxRunning: number;
  #keptFinished: number;
  #now: () => number;
  #entries: Entry[] = [];
  #counter = 0;

  #onChange: (runningCount: number) => void;

  constructor(options: {
    maxRunning: number;
    keptFinished?: number;
    now?: () => number;
    /** Called after the number of running tasks may have changed. */
    onChange?: (runningCount: number) => void;
  }) {
    this.#onChange = options.onChange ?? (() => {});
    this.#maxRunning = options.maxRunning;
    this.#keptFinished = options.keptFinished ?? DEFAULT_KEPT_FINISHED;
    this.#now = options.now ?? Date.now;
  }

  /** The limit may change between calls, because the config is read again for each call. */
  setMaxRunning(maxRunning: number): void {
    this.#maxRunning = maxRunning;
  }

  start(request: StartRequest): StartResult {
    const running = this.#runningCount();
    if (running >= this.#maxRunning) {
      return { refusal: `${running} background subagents are already running (the limit is ${this.#maxRunning}). Wait for one to finish, or cancel one.` };
    }

    this.#counter += 1;
    const oneLine = request.task.replace(/\s+/g, " ").trim();
    const summary = oneLine.length > MAX_SUMMARY_CHARS ? `${oneLine.slice(0, MAX_SUMMARY_CHARS - 1)}…` : oneLine;
    const task: BackgroundTask = { id: `bg-${this.#counter}`, summary, task: request.task, status: "running", startedAt: this.#now() };
    const entry: Entry = { task, controller: new AbortController() };
    this.#entries.push(entry);

    void this.#watch(entry, request);
    this.#notifyChange();
    return { task: { ...task } };
  }

  #runningCount(): number {
    return this.#entries.filter((entry) => entry.task.status === "running").length;
  }

  #notifyChange(): void {
    try {
      this.#onChange(this.#runningCount());
    } catch {
      // A footer that cannot be drawn must not stop a subagent.
    }
  }

  async #watch(entry: Entry, request: StartRequest): Promise<void> {
    let outcome: BackgroundOutcome;
    try {
      outcome = await request.run(entry.controller.signal);
    } catch (error) {
      outcome = { text: "", error: error instanceof Error ? error.message : String(error) };
    }
    // A cancelled task has been reported by the one who cancelled it.
    if (entry.task.status === "cancelled") return;
    entry.task.status = outcome.error === undefined ? "done" : "failed";
    entry.task.finishedAt = this.#now();
    if (outcome.error !== undefined) entry.task.error = outcome.error;
    this.#dropOldFinished();
    this.#notifyChange();
    try {
      request.onFinish({ ...entry.task }, outcome);
    } catch {
      // The notification failed; nothing here may crash pi.
    }
  }

  #dropOldFinished(): void {
    const finished = this.#entries.filter((entry) => entry.task.status !== "running");
    const surplus = finished.length - this.#keptFinished;
    if (surplus <= 0) return;
    const dropped = new Set(finished.slice(0, surplus));
    this.#entries = this.#entries.filter((entry) => !dropped.has(entry));
  }

  /** Oldest first. */
  list(): BackgroundTask[] {
    return this.#entries.map((entry) => ({ ...entry.task }));
  }

  /** Returns a message when nothing was cancelled. */
  cancel(id: string): string | undefined {
    const entry = this.#entries.find((candidate) => candidate.task.id === id);
    if (!entry) return `There is no background subagent ${id}.`;
    if (entry.task.status !== "running") return `${id} is not running (${entry.task.status}).`;
    this.#stop(entry);
    this.#notifyChange();
    return undefined;
  }

  /** Stops every running task without a result message. The caller says why: the session ends, or the user asked. */
  cancelAll(): void {
    for (const entry of this.#entries) {
      if (entry.task.status === "running") this.#stop(entry);
    }
    this.#notifyChange();
  }

  #stop(entry: Entry): void {
    entry.task.status = "cancelled";
    entry.task.finishedAt = this.#now();
    entry.controller.abort();
  }
}
