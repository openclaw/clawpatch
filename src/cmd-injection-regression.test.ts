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
import { scriptCommand, nxCommand } from "./mappers/projects.js";
import { nodeScriptCommand } from "./mappers/shared.js";
import { turboCommand } from "./mappers/turbo.js";

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

  it("turboCommand: malicious turbo --filter (package name or root) is shell-quoted", () => {
    for (const pm of ["pnpm", "yarn", "bun", "npm"] as const) {
      // package.json `name`
      expect(isShellSafe(turboCommand(pm, "test", "$(id)")), `pm=${pm}`).toBe(true);
      // root fallback `./${project.root}`
      expect(isShellSafe(turboCommand(pm, "test", "./packages/$(id)-pkg")), `pm=${pm}`).toBe(true);
    }
  });

  it("turboCommand: ordinary inputs are unchanged (no over-quoting)", () => {
    expect(turboCommand("pnpm", "test", "my-pkg")).toBe("pnpm turbo run test --filter my-pkg");
    expect(turboCommand("npm", "test", "./packages/ui")).toBe(
      "npx turbo run test --filter ./packages/ui",
    );
  });

  it("nxCommand: malicious Nx project name is shell-quoted", () => {
    for (const pm of ["npm", "bun", "pnpm", "yarn"] as const) {
      const cmd = nxCommand(pm, "test", "$(id)");
      expect(isShellSafe(cmd), `pm=${pm} cmd=${cmd}`).toBe(true);
    }
  });

  it("nxCommand: ordinary inputs are unchanged", () => {
    expect(nxCommand("npm", "test", "my-app")).toBe("npx nx test my-app");
    expect(nxCommand("pnpm", "build", "my-app")).toBe("pnpm nx build my-app");
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

  it("rust end-to-end: malicious conventional crate directory cannot inject into cargo --manifest-path", async () => {
    const root = await mkdtemp(join(tmpdir(), "clawpatch-cmd-inj-rust-"));
    try {
      // A workspace with no declared members triggers conventional crate
      // discovery, which reads `crates/*` straight off disk — so the directory
      // name flows into `cargo test --manifest-path <dir>/Cargo.toml`.
      await writeFile(join(root, "Cargo.toml"), '[workspace]\nresolver = "2"\n');
      const maliciousCrate = join("crates", "$(id)-crate");
      await mkdir(join(root, maliciousCrate, "src"), { recursive: true });
      await writeFile(
        join(root, maliciousCrate, "Cargo.toml"),
        '[package]\nname = "evil"\nversion = "0.1.0"\nedition = "2021"\n',
      );
      await writeFile(join(root, maliciousCrate, "src", "lib.rs"), "pub fn evil() {}\n");
      await mkdir(join(root, maliciousCrate, "tests"), { recursive: true });
      await writeFile(join(root, maliciousCrate, "tests", "it.rs"), "#[test]\nfn it() {}\n");

      const project = await detectProject(root);
      const result = await mapFeatures(root, project, []);
      const allCommands = result.features.flatMap((feature) =>
        validationCommandsForFeature(feature, {
          typecheck: null,
          lint: null,
          format: null,
          test: null,
        }),
      );
      // Guard against a silently-empty assertion: the malicious crate must
      // actually produce the manifest-path command we're checking.
      expect(
        allCommands.some((c) => c.includes("--manifest-path")),
        `expected a --manifest-path command, got: ${JSON.stringify(allCommands)}`,
      ).toBe(true);
      for (const c of allCommands) {
        expect(isShellSafe(c), `unsafe command produced: ${c}`).toBe(true);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
