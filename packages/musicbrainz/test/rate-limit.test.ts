import { describe, it, expect } from "vitest";
import { RateLimiter } from "../src/rate-limit.js";

describe("RateLimiter", () => {
  it("serializes tasks in order", async () => {
    const limiter = new RateLimiter(0, async () => {});
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => limiter.run(async () => order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it("spaces task starts by the min interval (virtual clock)", async () => {
    // Virtual clock: sleep advances it, now reads it → deterministic spacing.
    let clock = 0;
    const sleep = async (ms: number) => {
      clock += ms;
    };
    const now = () => clock;
    const limiter = new RateLimiter(1000, sleep, now);

    const starts: number[] = [];
    await limiter.run(async () => void starts.push(clock));
    await limiter.run(async () => void starts.push(clock));
    await limiter.run(async () => void starts.push(clock));
    // Three back-to-back tasks start at 0, 1000, 2000 — exactly 1/sec.
    expect(starts).toEqual([0, 1000, 2000]);
  });

  it("a rejecting task does not wedge the queue", async () => {
    const limiter = new RateLimiter(0, async () => {});
    await expect(limiter.run(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(limiter.run(async () => "ok")).resolves.toBe("ok");
  });
});
