export interface Timers {
  set(callback: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface BatcherOptions {
  batchMs: number;
  timers: Timers;
  onBatch: (lines: string[]) => void;
}

/** Groups lines that arrive close together, so one burst wakes the model once. */
export class LineBatcher {
  #lines: string[] = [];
  #handle: unknown;
  readonly #options: BatcherOptions;

  constructor(options: BatcherOptions) {
    this.#options = options;
  }

  add(line: string): void {
    this.#lines.push(line);
    if (this.#handle !== undefined) return;
    this.#handle = this.#options.timers.set(() => this.flush(), this.#options.batchMs);
  }

  flush(): void {
    if (this.#handle !== undefined) this.#options.timers.clear(this.#handle);
    this.#handle = undefined;
    if (this.#lines.length === 0) return;
    const lines = this.#lines;
    this.#lines = [];
    this.#options.onBatch(lines);
  }

  /** Drops the lines that were not sent. */
  discard(): void {
    if (this.#handle !== undefined) this.#options.timers.clear(this.#handle);
    this.#handle = undefined;
    this.#lines = [];
  }
}
