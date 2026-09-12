import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { doctorCommand, makeContext } from "./app.js";
import { defaultConfig } from "./config.js";
import { pathExists } from "./fs.js";
import { providerByName } from "./provider.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";

beforeEach(() => {
  for (const name of [
    "CLAWPATCH_CONFIG",
    "CLAWPATCH_PROVIDER",
    "CLAWPATCH_MODEL",
    "CLAWPATCH_REASONING_EFFORT",
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.spyOn(providerByName("codex"), "check").mockResolvedValue("unexpected default provider");
});
afterEach(() => vi.unstubAllEnvs());

describe("doctor configuration before initialization", () => {
  it.each(["option", "environment"])("loads standalone config selected by %s", async (source) => {
    const root = await fixtureRoot("clawpatch-doctor-config-");
    const config = defaultConfig();
    config.provider = {
      ...config.provider,
      name: "mock",
      model: "fixture-model",
      reasoningEffort: "high",
    };
    await writeFixture(root, "trusted.json", JSON.stringify(config));
    const options = testOptions(root);
    if (source === "option") options.config = join(root, "trusted.json");
    else vi.stubEnv("CLAWPATCH_CONFIG", join(root, "trusted.json"));
    const context = await makeContext(options);
    expect(await doctorCommand(context)).toMatchObject({
      state: "missing",
      provider: "mock",
      model: "fixture-model",
      reasoningEffort: "high",
      providerVersion: "mock",
    });
    expect(await pathExists(join(root, ".clawpatch"))).toBe(false);
  });

  it("keeps flag overrides ahead of environment and config", async () => {
    const root = await fixtureRoot("clawpatch-doctor-precedence-");
    const config = defaultConfig();
    config.provider.name = "mock-fail";
    await writeFixture(root, "clawpatch.config.json", JSON.stringify(config));
    vi.stubEnv("CLAWPATCH_PROVIDER", "codex");
    vi.stubEnv("CLAWPATCH_MODEL", "environment-model");
    const context = await makeContext(testOptions(root));
    expect(await doctorCommand(context, { provider: "mock", model: "flag-model" })).toMatchObject({
      provider: "mock",
      model: "flag-model",
    });
  });
});
