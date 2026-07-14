import { lstat, readdir, realpath } from "node:fs/promises";
import type { Stats } from "node:fs";

export type VfsCache = {
  readDirectory(path: string): Promise<string[]>;
  fileStat(path: string): Promise<Stats>;
  resolveRealpath(path: string): Promise<string>;
};

export function createVfsCache(): VfsCache {
  const dirCache = new Map<string, Promise<string[]>>();
  const statCache = new Map<string, Promise<Stats>>();
  const realpathCache = new Map<string, Promise<string>>();

  return {
    readDirectory(path: string): Promise<string[]> {
      let cached = dirCache.get(path);
      if (cached === undefined) {
        cached = readdir(path).catch(() => []);
        dirCache.set(path, cached);
      }
      return cached;
    },

    fileStat(path: string): Promise<Stats> {
      let cached = statCache.get(path);
      if (cached === undefined) {
        cached = lstat(path);
        statCache.set(path, cached);
      }
      return cached;
    },

    resolveRealpath(path: string): Promise<string> {
      let cached = realpathCache.get(path);
      if (cached === undefined) {
        cached = realpath(path).catch(() => path);
        realpathCache.set(path, cached);
      }
      return cached;
    },
  };
}
