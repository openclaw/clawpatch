import { describe, expect, it } from "vitest";
import { createRpmLimiter, defaultJobs, rpmFromFlag } from "./rpm-limiter.js";

type ScheduledTimeout = { handler: () => void; runAt: number };

function makeFakeClock() {
  let nowMs = 0;
  const pending: ScheduledTimeout[] = [];
  return {
    clock: {
      now: () => nowMs,
      setTimeout: (handler: () => void, ms: number) => {
        pending.push({ handler, runAt: nowMs + ms });
      },
    },
    advance(ms: number): void {
      nowMs += ms;
      // Fire any timeouts due at or before the current time, in scheduled order.
      while (true) {
        const due = pending.findIndex((entry) => entry.runAt <= nowMs);
        if (due === -1) {
          return;
        }
        const [entry] = pending.splice(due, 1);
        entry?.handler();
      }
    },
    setNow(ms: number): void {
      nowMs = ms;
    },
    pending: () => pending.length,
  };
}

describe("defaultJobs", () => {
  it("returns floor(cores / 2) capped at 10", () => {
    expect(defaultJobs(4)).toBe(2);
    expect(defaultJobs(8)).toBe(4);
    expect(defaultJobs(32)).toBe(10);
  });

  it("clamps to a minimum of 1", () => {
    expect(defaultJobs(1)).toBe(1);
    expect(defaultJobs(0)).toBe(1);
    expect(defaultJobs(Number.NaN)).toBe(1);
  });
});

describe("rpmFromFlag", () => {
  it("prefers explicit flag over env", () => {
    expect(rpmFromFlag("30", "60")).toBe(30);
  });

  it("falls back to env when flag is missing", () => {
    expect(rpmFromFlag(undefined, "45")).toBe(45);
  });

  it("returns undefined when neither is set", () => {
    expect(rpmFromFlag(undefined, undefined)).toBeUndefined();
    expect(rpmFromFlag("", "")).toBeUndefined();
  });

  it("returns undefined for invalid values", () => {
    expect(rpmFromFlag("abc", undefined)).toBeUndefined();
    expect(rpmFromFlag("0", undefined)).toBeUndefined();
    expect(rpmFromFlag("-5", undefined)).toBeUndefined();
  });
});

describe("createRpmLimiter", () => {
  it("is a no-op when limit is undefined", async () => {
    const limiter = createRpmLimiter(undefined);
    for (let i = 0; i < 100; i += 1) {
      await limiter.acquire();
    }
  });

  it("is a no-op when limit is invalid", async () => {
    const limiter = createRpmLimiter(0);
    await limiter.acquire();
    const limiter2 = createRpmLimiter(Number.NaN);
    await limiter2.acquire();
  });

  it("allows up to N starts in a 60s window without delay", async () => {
    const fake = makeFakeClock();
    const limiter = createRpmLimiter(3, fake.clock);
    await limiter.acquire();
    await limiter.acquire();
    await limiter.acquire();
    expect(fake.pending()).toBe(0);
  });

  it("delays the (N+1)th call until the oldest slot expires", async () => {
    const fake = makeFakeClock();
    const limiter = createRpmLimiter(2, fake.clock);
    await limiter.acquire();
    fake.advance(10_000);
    await limiter.acquire();

    let resolved = false;
    const pending = limiter.acquire().then(() => {
      resolved = true;
    });

    // Allow the chain to evaluate `step` and schedule its setTimeout.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    // First slot was at t=0, window is 60s, so the next slot opens at t=60_000.
    fake.advance(50_000);
    await pending;
    expect(resolved).toBe(true);
  });
});
