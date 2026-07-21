import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createNearbyTestFinder, walkByPolicy } from "./shared.js";

describe("shared filesystem inventory", () => {
  it("prunes each policy at directory traversal time", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawpatch-walk-policy-"));
    try {
      await Promise.all([
        mkdir(join(root, "src"), { recursive: true }),
        mkdir(join(root, "vendor"), { recursive: true }),
        mkdir(join(root, "obj"), { recursive: true }),
      ]);
      await Promise.all([
        writeFile(join(root, "src", "main.txt"), "source"),
        writeFile(join(root, "vendor", "dependency.txt"), "dependency"),
        writeFile(join(root, "obj", "generated.txt"), "generated"),
      ]);

      const files = await walkByPolicy(
        root,
        [""],
        [
          { key: "all", skipPath: () => false },
          { key: "no-vendor", skipPath: (path) => path === "vendor" },
          { key: "no-obj", skipPath: (path) => path === "obj" },
        ],
      );

      expect(files.get("all")).toEqual([
        "obj/generated.txt",
        "src/main.txt",
        "vendor/dependency.txt",
      ]);
      expect(files.get("no-vendor")).toEqual(["obj/generated.txt", "src/main.txt"]);
      expect(files.get("no-obj")).toEqual(["src/main.txt", "vendor/dependency.txt"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
