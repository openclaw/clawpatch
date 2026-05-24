// Regression tests for command-injection via filesystem-derived paths
// reaching shell-interpreted command strings in the validation pipeline.
//
// `runCommand` in src/exec.ts uses `spawn(..., { shell: true })`, so any
// command string the validation pipeline produces is passed straight to
// /bin/sh -c. Each mapper that interpolates a filesystem-derived path or
// package-config-derived name into a command string must shell-quote that
// value via `shellQuotePath` so attacker-controlled metacharacters cannot
// be parsed as shell syntax.
//
// Each test below builds a project tree with attacker-controlled names
// and asserts the produced commands are shell-safe (no unquoted `$(...)`,
// no unquoted `;`, etc.).

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { mapFeatures } from "./mapper.js";
import { validationCommandsForFeature } from "./validation.js";
import { detectProject } from "./detect.js";
import { scriptCommand } from "./mappers/projects.js";
import { nodeScriptCommand } from "./mappers/shared.js";

function isShellSafe(command: string): boolean {
  // Strip double-quoted segments — anything `$(...)` or `;` inside `"..."`
  // is shell-literal (backslash-escaped `$` and `\`).
  const withoutQuoted = command.replace(/"(?:\\.|[^"\\])*"/gu, "");
  if (/\$\(/u.test(withoutQuoted)) return false;
  if (/`/u.test(withoutQuoted)) return false;
  if (/(?:^|\s);/u.test(withoutQuoted)) return false;
  if (/&&|\|\|/u.test(withoutQuoted)) return false;
  return true;
}

describe("validation pipeline shell-quotes filesystem-derived names (regression)", () => {
  it("scriptCommand: malicious workspace package-root is shell-quoted", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      const cmd = scriptCommand(pm, "packages/$(id)-pkg", "test");
      expect(isShellSafe(cmd), `pm=${pm} cmd=${cmd}`).toBe(true);
    }
  });

  it("scriptCommand: malicious package.json script-name is shell-quoted", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      const cmd = scriptCommand(pm, "packages/ok", "$(id)");
      expect(isShellSafe(cmd), `pm=${pm} cmd=${cmd}`).toBe(true);
    }
  });

  it("scriptCommand: ordinary inputs are unchanged (no over-quoting)", () => {
    expect(scriptCommand("pnpm", "packages/ui", "test")).toBe("pnpm --dir packages/ui test");
    expect(scriptCommand("npm", "packages/ui", "test")).toBe("npm --prefix packages/ui run test");
    expect(scriptCommand("yarn", "packages/ui", "test")).toBe("yarn --cwd packages/ui test");
    expect(scriptCommand("bun", "packages/ui", "test")).toBe("bun --cwd packages/ui run test");
    expect(scriptCommand("pnpm", ".", "test")).toBe("pnpm test");
    expect(scriptCommand("npm", ".", "test")).toBe("npm run test");
    expect(scriptCommand("bun", ".", "test")).toBe("bun run test");
  });

  it("nodeScriptCommand: malicious workspace package-root is shell-quoted", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      const cmd = nodeScriptCommand(pm, "packages/$(id)-pkg", "test");
      expect(isShellSafe(cmd), `pm=${pm} cmd=${cmd}`).toBe(true);
    }
  });

  it("nodeScriptCommand: ordinary inputs are unchanged", () => {
    expect(nodeScriptCommand("pnpm", "apps/web", "test")).toBe("pnpm --dir apps/web test");
    expect(nodeScriptCommand("npm", "apps/web", "test")).toBe("npm --prefix apps/web run test");
  });

  it("swift end-to-end: malicious package-root directory cannot inject into swift test --package-path", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawpatch-cmd-inj-swift-"));
    try {
      const maliciousPkg = "$(id)-pkg";
      await mkdir(join(root, maliciousPkg, "Sources", "Evil"), { recursive: true });
      await writeFile(
        join(root, maliciousPkg, "Package.swift"),
        '// swift-tools-version:5.9\nimport PackageDescription\nlet package = Package(name: "evil", targets: [.target(name: "Evil"), .testTarget(name: "EvilTests", dependencies: ["Evil"])])\n',
      );
      await writeFile(
        join(root, maliciousPkg, "Sources", "Evil", "Evil.swift"),
        "public struct Evil {}\n",
      );
      await mkdir(join(root, maliciousPkg, "Tests", "EvilTests"), { recursive: true });
      await writeFile(
        join(root, maliciousPkg, "Tests", "EvilTests", "EvilTests.swift"),
        "import XCTest\nclass EvilTests: XCTestCase {}\n",
      );
      const project = await detectProject(root);
      const result = await mapFeatures(root, project, []);
      for (const feature of result.features) {
        const commands = validationCommandsForFeature(feature, {
          typecheck: null,
          lint: null,
          format: null,
          test: null,
        });
        for (const c of commands) {
          expect(isShellSafe(c), `unsafe command produced: ${c}`).toBe(true);
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
