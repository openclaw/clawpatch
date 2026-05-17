#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const moduleRequire = createRequire(import.meta.url);
const root = process.cwd();
const tmp = mkdtempSync(join(tmpdir(), "clawpatch-pack-smoke-"));
const fixtureRoot = join(tmp, "fixture");
const installRoot = join(tmp, "installed");
const npmCache = join(tmp, "npm-cache");

function write(path, contents) {
  const full = join(fixtureRoot, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: npmCache,
      npm_config_cache: npmCache,
      npm_config_update_notifier: "false",
    },
    shell: needsWindowsShell(command) ? (process.env.ComSpec ?? true) : false,
    stdio: options.stdio ?? "pipe",
  });
}

function needsWindowsShell(command) {
  return (
    process.platform === "win32" && (!command.includes("/") || /\.(?:cmd|bat)$/iu.test(command))
  );
}

try {
  write(
    "pyproject.toml",
    [
      "[project]",
      'name = "mixed-app"',
      'dependencies = ["fastapi", "pytest"]',
      "",
      "[tool.pytest.ini_options]",
      'testpaths = ["tests"]',
      "",
    ].join("\n"),
  );
  write("app/__init__.py", "");
  write(
    "app/main.py",
    [
      "from fastapi import FastAPI",
      "",
      "app = FastAPI()",
      "",
      '@app.post("/webhook")',
      "async def webhook() -> dict[str, str]:",
      '    return {"status": "ok"}',
      "",
    ].join("\n"),
  );
  write("tests/test_ingest.py", "def test_ingest() -> None:\n    assert True\n");
  write("pnpm-workspace.yaml", ["packages:", "  - frontend", ""].join("\n"));
  write(
    "frontend/package.json",
    JSON.stringify(
      {
        name: "frontend",
        scripts: { test: "vitest run" },
        dependencies: { next: "1.0.0" },
      },
      null,
      2,
    ),
  );
  write("frontend/src/app/dashboard/page.tsx", "export default function Page() { return null; }\n");
  write("frontend/src/app/dashboard/page.test.tsx", "test('dashboard', () => {});\n");

  const packOutput = JSON.parse(
    run("npm", ["pack", "--json", "--cache", npmCache, "--pack-destination", tmp], {
      stdio: "pipe",
    }),
  );
  const tarball = join(tmp, packFilename(packOutput));
  const zodPackOutput = JSON.parse(
    run(
      "npm",
      [
        "pack",
        "--json",
        "--cache",
        npmCache,
        "--pack-destination",
        tmp,
        dirname(moduleRequire.resolve("zod/package.json")),
      ],
      { stdio: "pipe" },
    ),
  );
  const zodTarball = join(tmp, packFilename(zodPackOutput));
  mkdirSync(installRoot, { recursive: true });
  run("npm", ["install", "--cache", npmCache, "--prefix", installRoot, tarball, zodTarball]);

  const bin = join(
    installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "clawpatch.cmd" : "clawpatch",
  );
  run(bin, ["--root", fixtureRoot, "init", "--force", "--json"]);
  const mapped = JSON.parse(run(bin, ["--root", fixtureRoot, "map", "--json"]));
  const features = JSON.parse(
    run("node", [
      "-e",
      [
        "const { readdirSync, readFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const dir = join(process.argv[1], '.clawpatch', 'features');",
        "console.log(JSON.stringify(readdirSync(dir).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))));",
      ].join(""),
      fixtureRoot,
    ]),
  );
  const sources = new Set(features.map((feature) => feature.source));
  const titles = new Set(features.map((feature) => feature.title));

  if (mapped.features < 4) {
    throw new Error(
      `expected packaged CLI to map several fixture features, got ${mapped.features}`,
    );
  }
  if (!sources.has("python-project")) {
    throw new Error("expected packaged CLI to include Python project mapping");
  }
  if (!sources.has("python-fastapi-route")) {
    throw new Error("expected packaged CLI to include FastAPI route mapping");
  }
  if (!titles.has("frontend route /dashboard")) {
    throw new Error("expected packaged CLI to include nested Next workspace route mapping");
  }

  console.log(`packaged CLI smoke mapped ${mapped.features} features`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

function packFilename(output) {
  const filename = Array.isArray(output) ? output[0]?.filename : null;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not report a tarball filename");
  }
  return filename;
}
