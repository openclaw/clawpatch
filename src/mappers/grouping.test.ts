import { describe, expect, it } from "vitest";
import { partitionFileGroups } from "./grouping.js";

describe("partitionFileGroups", () => {
  it("splits repeated direct file families before numeric chunks", () => {
    const groups = partitionFileGroups(
      "src",
      [
        "src/cli/command-alpha.ts",
        "src/cli/command-beta.ts",
        "src/cli/config-alpha.ts",
        "src/cli/config-beta.ts",
        "src/cli/other-a.ts",
        "src/cli/other-b.ts",
        "src/cli/solo.ts",
      ],
      3,
    );

    expect(groups).toContainEqual({
      label: "src/cli/:command",
      files: ["src/cli/command-alpha.ts", "src/cli/command-beta.ts"],
    });
    expect(groups).toContainEqual({
      label: "src/cli/:config",
      files: ["src/cli/config-alpha.ts", "src/cli/config-beta.ts"],
    });
    expect(groups).toContainEqual({
      label: "src/cli/:other",
      files: ["src/cli/other-a.ts", "src/cli/other-b.ts"],
    });
    expect(groups).toContainEqual({ label: "src/cli", files: ["src/cli/solo.ts"] });
  });

  it("keeps singleton families in the fallback chunk", () => {
    const groups = partitionFileGroups(
      "src",
      ["src/commands.ts", "src/config.ts", "src/index.ts", "src/runtime.ts", "src/session.ts"],
      3,
    );

    expect(groups).toEqual([
      { label: "src#1", files: ["src/commands.ts", "src/config.ts", "src/index.ts"] },
      { label: "src#2", files: ["src/runtime.ts", "src/session.ts"] },
    ]);
  });
});
