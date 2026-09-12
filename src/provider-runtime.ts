import { parseTimeoutMs } from "./timeout.js";

export function providerTimeoutMs(envName: string, defaultMs: number): number {
  const raw = process.env[envName] ?? process.env["CLAWPATCH_PROVIDER_TIMEOUT_MS"];
  return parseTimeoutMs(raw, defaultMs);
}

export function providerCheckTimeoutMs(): number {
  return providerTimeoutMs("CLAWPATCH_PROVIDER_CHECK_TIMEOUT_MS", 10_000);
}
