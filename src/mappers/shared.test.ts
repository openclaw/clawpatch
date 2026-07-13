import { describe, expect, it, vi } from "vitest";
import { createNearbyTestFinder, packageKind, packageTrustBoundaries } from "./shared.js";

describe("package semantics", () => {
  it("does not mistake client packages for CLI commands", () => {
    expect(packageKind("@apex/app-code-client packages/apps/code/code-client")).toBe("library");
    expect(
      packageTrustBoundaries("@apex/app-code-client packages/apps/code/code-client"),
    ).not.toContain("process-exec");
    expect(packageKind("@scope/tool-cli packages/tool-cli")).toBe("cli-command");
    expect(packageTrustBoundaries("@scope/tool-cli packages/tool-cli")).toContain("process-exec");
  });
});

describe("nearby test discovery", () => {
  it("caches shared directory walks for one mapping run", async () => {
    const walk = vi.fn(async (_root: string, prefixes: string[]) => {
      const prefix = prefixes[0];
      return prefix === "tests" ? ["tests/a.test.ts", "tests/b.test.ts"] : [];
    });
    const find = createNearbyTestFinder("/repo", walk);

    await expect(find("src/a.ts", "pnpm test", [])).resolves.toEqual([
      { path: "tests/a.test.ts", command: "pnpm test" },
    ]);
    await expect(find("src/b.ts", "pnpm test", [])).resolves.toEqual([
      { path: "tests/b.test.ts", command: "pnpm test" },
    ]);

    const prefixes = walk.mock.calls.map((call) => call[1][0]);
    expect(prefixes.filter((prefix) => prefix === "src")).toHaveLength(1);
    expect(prefixes.filter((prefix) => prefix === "tests")).toHaveLength(1);
    expect(walk).toHaveBeenCalledTimes(new Set(prefixes).size);
  });

  it("keeps C/C++ and default skip policies in separate cache entries", async () => {
    const walk = vi.fn(
      async (_root: string, _prefixes: string[], _skipPath?: (path: string) => boolean) =>
        [] as string[],
    );
    const find = createNearbyTestFinder("/repo", walk);

    await find("src/app.ts", null, []);
    await find("src/app.cpp", null, []);

    const srcWalks = walk.mock.calls.filter((call) => call[1][0] === "src");
    expect(srcWalks).toHaveLength(2);
    expect(srcWalks[0]?.[2]).not.toBe(srcWalks[1]?.[2]);
  });
});
