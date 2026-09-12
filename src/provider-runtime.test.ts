import { afterEach, describe, expect, it } from "vitest";
import { providerCheckTimeoutMs, providerTimeoutMs } from "./provider-runtime.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("provider runtime policy", () => {
  it("prefers provider-specific timeout over the global fallback", () => {
    process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"] = "200";
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "100";

    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(100);
    delete process.env["CLAWPATCH_TEST_TIMEOUT_MS"];
    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(200);
  });

  it("uses safe defaults for missing and invalid values", () => {
    delete process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "invalid";

    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(300);
    expect(providerCheckTimeoutMs()).toBe(10_000);
  });

  it.each(["2147483648", "1e100", "0.5"])("rejects unsafe timer delay %s", (value) => {
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = value;
    process.env["CLAWPATCH_PROVIDER_CHECK_TIMEOUT_MS"] = value;
    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(300);
    expect(providerCheckTimeoutMs()).toBe(10_000);
  });

  it("normalizes valid fractional delays without overflowing the timer range", () => {
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "1234.9";
    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(1234);
    process.env["CLAWPATCH_TEST_TIMEOUT_MS"] = "2147483647";
    expect(providerTimeoutMs("CLAWPATCH_TEST_TIMEOUT_MS", 300)).toBe(2147483647);
  });
});
