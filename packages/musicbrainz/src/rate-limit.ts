/**
 * A serialized min-interval rate limiter. MusicBrainz requires applications to
 * make **no more than one request per second per source IP** (503s / blocks
 * otherwise), so every call to the live service goes through one of these.
 *
 * `run` serializes tasks and spaces their *starts* by at least `minIntervalMs`.
 * `sleep` is injectable so tests are deterministic without real timers.
 */
export type Sleep = (ms: number) => Promise<void>;
export type Now = () => number;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private nextAllowedAt = 0;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly minIntervalMs = 1000,
    private readonly sleep: Sleep = realSleep,
    /** Clock source, injectable for deterministic tests (defaults to Date.now). */
    private readonly now: Now = () => Date.now(),
  ) {}

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const now = this.now();
      const wait = this.nextAllowedAt - now;
      if (wait > 0) await this.sleep(wait);
      // Reserve the next slot from whichever is later: now-after-wait, or the reserved time.
      this.nextAllowedAt = Math.max(this.now(), this.nextAllowedAt) + this.minIntervalMs;
      return task();
    });
    // Keep the chain alive even if a task rejects, so one failure doesn't wedge the queue.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
