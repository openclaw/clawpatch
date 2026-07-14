import { readdir } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createVfsCache } from "./vfs-cache.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(),
  };
});

describe("VfsCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("memoizes successful readdir calls", async () => {
    vi.mocked(readdir).mockResolvedValueOnce(["file1.txt", "file2.txt"] as any);
    const vfs = createVfsCache();

    const first = await vfs.readDirectory("/fake/path");
    const second = await vfs.readDirectory("/fake/path");

    expect(first).toEqual(["file1.txt", "file2.txt"]);
    expect(second).toEqual(["file1.txt", "file2.txt"]);
    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readdir).toHaveBeenCalledWith("/fake/path");
  });

  it("preserves and memoizes directory-read failures", async () => {
    const error = new Error("EACCES: permission denied, scandir '/fake/secret'");
    vi.mocked(readdir).mockRejectedValueOnce(error);
    const vfs = createVfsCache();

    await expect(vfs.readDirectory("/fake/secret")).rejects.toThrow(error);
    await expect(vfs.readDirectory("/fake/secret")).rejects.toThrow(error);

    expect(readdir).toHaveBeenCalledTimes(1);
    expect(readdir).toHaveBeenCalledWith("/fake/secret");
  });
});
