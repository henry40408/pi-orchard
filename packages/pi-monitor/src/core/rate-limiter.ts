const WINDOW_MS = 60_000;

/** Counts events in a sliding one-minute window. */
export class RateLimiter {
  #times: number[] = [];
  readonly #maxPerMinute: number;
  readonly #now: () => number;

  constructor(maxPerMinute: number, now: () => number) {
    this.#maxPerMinute = maxPerMinute;
    this.#now = now;
  }

  /** Records one event. Returns true when the window now holds more than the limit. */
  record(): boolean {
    const now = this.#now();
    this.#times.push(now);
    while (this.#times.length > 0 && now - this.#times[0]! >= WINDOW_MS) this.#times.shift();
    return this.#times.length > this.#maxPerMinute;
  }
}
