import { afterEach, describe, expect, it, vi } from "vitest";
import { __testing as appTesting, AppContext } from "./app.js";
import { ClawpatchError } from "./errors.js";
import type { ReviewOutput } from "./types.js";

// eslint-disable-next-line no-underscore-dangle
const { isRetryableReviewError, reviewRetries, runProviderReviewWithRetry } = appTesting;

const QUIET_CONTEXT: AppContext = {
  root: "/tmp/test-root",
  options: {
    root: "/tmp/test-root",
    json: false,
    plain: false,
    quiet: true,
    verbose: false,
    debug: false,
    noColor: true,
    noInput: true,
  },
};

function emptyReview(): ReviewOutput {
  return { findings: [], inspected: { files: [], symbols: [], notes: ["ok"] } };
}

function withEnv(name: string, value: string | undefined, fn: () => void): void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  }
}

describe("isRetryableReviewError", () => {
  it("returns true for malformed-output ClawpatchError", () => {
    expect(isRetryableReviewError(new ClawpatchError("bad", 8, "malformed-output"))).toBe(true);
  });

  it("returns false for provider-auth", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 4, "provider-auth"))).toBe(false);
  });

  it("returns false for unsupported-provider", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 2, "unsupported-provider"))).toBe(
      false,
    );
  });

  it("returns false for agent-refused", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "agent-refused"))).toBe(false);
  });

  it("returns false for agent-cancelled", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "agent-cancelled"))).toBe(false);
  });

  it("returns false for provider-failure (acpx-layer handles those)", () => {
    expect(isRetryableReviewError(new ClawpatchError("nope", 1, "provider-failure"))).toBe(false);
  });

  it("returns false for plain Error", () => {
    expect(isRetryableReviewError(new Error("oops"))).toBe(false);
  });
});

describe("reviewRetries", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
  });

  it("defaults to 1", () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    expect(reviewRetries()).toBe(1);
  });

  it("respects 0 (disables retry)", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "0", () => {
      expect(reviewRetries()).toBe(0);
    });
  });

  it("respects positive integer override", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "2", () => {
      expect(reviewRetries()).toBe(2);
    });
  });

  it("falls back to 1 on garbage input", () => {
    withEnv("CLAWPATCH_REVIEW_RETRIES", "abc", () => {
      expect(reviewRetries()).toBe(1);
    });
  });
});

function fakeProvider(reviewImpl: (...args: unknown[]) => Promise<ReviewOutput>): {
  name: string;
  check: () => Promise<string>;
  map: () => Promise<never>;
  review: (...args: unknown[]) => Promise<ReviewOutput>;
  fix: () => Promise<never>;
  revalidate: () => Promise<never>;
} {
  return {
    name: "fake",
    async check(): Promise<string> {
      return "fake";
    },
    async map(): Promise<never> {
      throw new Error("not used");
    },
    review: reviewImpl,
    async fix(): Promise<never> {
      throw new Error("not used");
    },
    async revalidate(): Promise<never> {
      throw new Error("not used");
    },
  };
}

describe("runProviderReviewWithRetry", () => {
  afterEach(() => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
  });

  it("returns output on first try without retry", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi.fn().mockResolvedValue(emptyReview());
    const provider = fakeProvider(review);
    const result = await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: provider as any,
      root: "/tmp",
      prompt: "hi",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {} as any,
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
    expect(result.findings).toEqual([]);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("retries once on malformed-output then succeeds", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const review = vi
      .fn()
      .mockRejectedValueOnce(new ClawpatchError("garbled", 8, "malformed-output"))
      .mockResolvedValueOnce(emptyReview());
    const provider = fakeProvider(review);
    const result = await runProviderReviewWithRetry({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      provider: provider as any,
      root: "/tmp",
      prompt: "hi",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: {} as any,
      context: QUIET_CONTEXT,
      featureId: "feat_x",
      index: 0,
      total: 1,
    });
    expect(result.findings).toEqual([]);
    expect(review).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry on provider-auth", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const err = new ClawpatchError("auth", 4, "provider-auth");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry on agent-cancelled", async () => {
    delete process.env["CLAWPATCH_REVIEW_RETRIES"];
    const err = new ClawpatchError("cancel", 1, "agent-cancelled");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("respects CLAWPATCH_REVIEW_RETRIES=0 (no retry, malformed-output fails on first attempt)", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "0";
    const err = new ClawpatchError("garbled", 8, "malformed-output");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("re-throws after maxAttempts when malformed-output persists", async () => {
    process.env["CLAWPATCH_REVIEW_RETRIES"] = "1";
    const err = new ClawpatchError("garbled", 8, "malformed-output");
    const review = vi.fn().mockRejectedValue(err);
    const provider = fakeProvider(review);
    await expect(
      runProviderReviewWithRetry({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        provider: provider as any,
        root: "/tmp",
        prompt: "hi",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options: {} as any,
        context: QUIET_CONTEXT,
        featureId: "feat_x",
        index: 0,
        total: 1,
      }),
    ).rejects.toBe(err);
    expect(review).toHaveBeenCalledTimes(2);
  });
});
