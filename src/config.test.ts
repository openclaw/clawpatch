import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { defaultConfig, loadConfig } from "./config.js";
import { fixtureRoot, testOptions, writeFixture } from "./test-helpers.js";

const originalConfig = process.env["CLAWPATCH_CONFIG"];
const originalStateDir = process.env["CLAWPATCH_STATE_DIR"];

beforeEach(() => {
  delete process.env["CLAWPATCH_CONFIG"];
  delete process.env["CLAWPATCH_STATE_DIR"];
});

afterEach(() => {
  if (originalConfig === undefined) {
    delete process.env["CLAWPATCH_CONFIG"];
  } else {
    process.env["CLAWPATCH_CONFIG"] = originalConfig;
  }
  if (originalStateDir === undefined) {
    delete process.env["CLAWPATCH_STATE_DIR"];
  } else {
    process.env["CLAWPATCH_STATE_DIR"] = originalStateDir;
  }
});

function configWithCodexPassthrough() {
  return {
    ...defaultConfig(),
    provider: {
      ...defaultConfig().provider,
      codexConfig: {
        model_provider: "openai",
        "model_providers.openai.env_key": "OPENAI_API_KEY",
      },
    },
  };
}

describe("loadConfig", () => {
  it("defaults Codex passthrough config to an empty object", async () => {
    const root = await fixtureRoot("clawpatch-default-config-");

    const config = await loadConfig(root, testOptions(root));

    expect(config.provider.codexConfig).toEqual({});
  });

  it("rejects Codex passthrough config from project config", async () => {
    const root = await fixtureRoot("clawpatch-project-codex-config-");
    await writeFixture(root, "clawpatch.config.json", JSON.stringify(configWithCodexPassthrough()));

    await expect(loadConfig(root, testOptions(root))).rejects.toThrow(
      /provider\.codexConfig may only be set/u,
    );
  });

  it("rejects Codex passthrough config from state-dir config", async () => {
    const root = await fixtureRoot("clawpatch-state-codex-config-root-");
    const stateDir = await fixtureRoot("clawpatch-state-codex-config-");
    await writeFixture(stateDir, "config.json", JSON.stringify(configWithCodexPassthrough()));

    await expect(loadConfig(root, { ...testOptions(root), stateDir })).rejects.toThrow(
      /provider\.codexConfig may only be set/u,
    );
  });

  it("accepts Codex passthrough config from --config", async () => {
    const root = await fixtureRoot("clawpatch-explicit-codex-config-");
    const configPath = join(root, "trusted-config.json");
    await writeFixture(root, "trusted-config.json", JSON.stringify(configWithCodexPassthrough()));

    const config = await loadConfig(root, { ...testOptions(root), config: configPath });

    expect(config.provider.codexConfig).toEqual({
      model_provider: "openai",
      "model_providers.openai.env_key": "OPENAI_API_KEY",
    });
  });

  it("accepts Codex passthrough config from CLAWPATCH_CONFIG", async () => {
    const root = await fixtureRoot("clawpatch-env-codex-config-");
    const configPath = join(root, "trusted-config.json");
    await writeFixture(root, "trusted-config.json", JSON.stringify(configWithCodexPassthrough()));
    process.env["CLAWPATCH_CONFIG"] = configPath;

    const config = await loadConfig(root, testOptions(root));

    expect(config.provider.codexConfig).toEqual({
      model_provider: "openai",
      "model_providers.openai.env_key": "OPENAI_API_KEY",
    });
  });
});
