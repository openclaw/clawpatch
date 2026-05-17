import { join } from "node:path";
import { pathExists } from "../fs.js";
import { FeatureSeed } from "./types.js";

export async function configSeeds(root: string): Promise<FeatureSeed[]> {
  const candidates = [
    "package.json",
    "tsconfig.json",
    "turbo.json",
    "oxlint.json",
    "vitest.config.ts",
    "go.mod",
    "Cargo.toml",
    "Cargo.lock",
    "rust-toolchain.toml",
    "Package.swift",
    "composer.json",
    "composer.lock",
    "phpunit.xml",
    "Makefile",
  ];
  const seeds: FeatureSeed[] = [];
  for (const file of candidates) {
    if (await pathExists(join(root, file))) {
      seeds.push({
        title: `Project config ${file}`,
        summary: `Build, release, or quality configuration in ${file}.`,
        kind: "config",
        source: "shared-infra-heuristic",
        confidence: "medium",
        entryPath: file,
        symbol: null,
        route: null,
        command: null,
        tags: ["config"],
        trustBoundaries: ["process-exec", "filesystem"],
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}
