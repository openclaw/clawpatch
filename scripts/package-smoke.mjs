#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const root = process.cwd();

function createSmokeContext() {
  const tmp = mkdtempSync(join(tmpdir(), "clawpatch-pack-smoke-"));
  return {
    root,
    tmp,
    fixtureRoot: join(tmp, "fixture"),
    installRoot: join(tmp, "installed"),
    npmCache: join(tmp, "npm-cache"),
  };
}

function write(context, path, contents) {
  const full = join(context.fixtureRoot, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function run(context, command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? context.root,
    encoding: "utf8",
    env: {
      ...process.env,
      NPM_CONFIG_CACHE: context.npmCache,
      npm_config_cache: context.npmCache,
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

export function main() {
  const context = createSmokeContext();
  try {
    runSmoke(context);
  } finally {
    rmSync(context.tmp, { recursive: true, force: true });
  }
}

function runSmoke(context) {
  write(
    context,
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
  write(context, "app/__init__.py", "");
  write(
    context,
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
  write(context, "tests/test_ingest.py", "def test_ingest() -> None:\n    assert True\n");
  write(context, "pnpm-workspace.yaml", ["packages:", "  - frontend", ""].join("\n"));
  write(
    context,
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
  write(
    context,
    "frontend/src/app/dashboard/page.tsx",
    "export default function Page() { return null; }\n",
  );
  write(context, "frontend/src/app/dashboard/page.test.tsx", "test('dashboard', () => {});\n");
  write(
    context,
    "CMakeLists.txt",
    [
      "cmake_minimum_required(VERSION 3.18)",
      "project(cuda_smoke LANGUAGES CXX CUDA)",
      "find_package(CUDAToolkit REQUIRED)",
      "add_executable(cuda_app src/main.cpp kernels/vector_add.cu)",
      "target_include_directories(cuda_app PRIVATE include)",
      "target_link_libraries(cuda_app PRIVATE CUDA::cudart)",
      "cuda_add_library(legacy_cuda kernels/legacy.cu)",
      "",
    ].join("\n"),
  );
  write(context, "configure.ac", "AC_INIT([cuda-smoke], [0.1])\nAC_OUTPUT\n");
  write(
    context,
    "src/main.cpp",
    '#include "vector_add.cuh"\nint main() { return launch_vector_add(); }\n',
  );
  write(context, "include/vector_add.cuh", "#pragma once\nint launch_vector_add();\n");
  write(
    context,
    "kernels/vector_add.cu",
    [
      '#include "vector_add.cuh"',
      "__global__ void vector_add_kernel() {}",
      "int launch_vector_add() { vector_add_kernel<<<1, 1>>>(); return 0; }",
      "",
    ].join("\n"),
  );
  write(context, "kernels/legacy.cu", "__global__ void legacy_kernel() {}\n");

  const packOutput = JSON.parse(
    run(
      context,
      "npm",
      ["pack", "--json", "--cache", context.npmCache, "--pack-destination", context.tmp],
      {
        stdio: "pipe",
      },
    ),
  );
  const tarball = packPath(context.tmp, packOutput);
  const dependencyTarballs = runtimeDependencyTarballs(context);
  mkdirSync(context.installRoot, { recursive: true });
  run(
    context,
    "npm",
    installArgs({
      installRoot: context.installRoot,
      npmCache: context.npmCache,
      tarball,
      dependencyTarballs,
    }),
  );
  verifyRuntimeDependencies(context);

  const bin = join(
    context.installRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "clawpatch.cmd" : "clawpatch",
  );
  run(context, bin, ["--root", context.fixtureRoot, "init", "--force", "--json"]);
  const mapped = JSON.parse(run(context, bin, ["--root", context.fixtureRoot, "map", "--json"]));
  const features = JSON.parse(
    run(context, "node", [
      "-e",
      [
        "const { readdirSync, readFileSync } = require('node:fs');",
        "const { join } = require('node:path');",
        "const dir = join(process.argv[1], '.clawpatch', 'features');",
        "console.log(JSON.stringify(readdirSync(dir).map((file) => JSON.parse(readFileSync(join(dir, file), 'utf8')))));",
      ].join(""),
      context.fixtureRoot,
    ]),
  );
  const sources = new Set(features.map((feature) => feature.source));
  const titles = new Set(features.map((feature) => feature.title));
  const cudaFeatures = features.filter((feature) => feature.tags?.includes("cuda") === true);

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
  if (!titles.has("CMake binary cuda_app")) {
    throw new Error("expected packaged CLI to include CUDA CMake executable mapping");
  }
  if (!titles.has("CMake library legacy_cuda")) {
    throw new Error("expected packaged CLI to include legacy CUDA CMake library mapping");
  }
  if (!cudaFeatures.some((feature) => feature.title === "CMake binary cuda_app")) {
    throw new Error("expected CUDA CMake executable mapping to be tagged cuda");
  }
  if (!cudaFeatures.some((feature) => feature.title === "CMake library legacy_cuda")) {
    throw new Error("expected legacy CUDA CMake library mapping to be tagged cuda");
  }
  if (
    !features.some(
      (feature) =>
        feature.source === "shared-infra-heuristic" &&
        feature.ownedFiles.some((file) => file.path === "CMakeLists.txt"),
    )
  ) {
    throw new Error("expected packaged CLI to include CMake config mapping");
  }
  if (!cudaFeatures.every((feature) => feature.trustBoundaries.includes("concurrency"))) {
    throw new Error("expected packaged CLI CUDA features to include concurrency boundary");
  }

  console.log(
    `packaged CLI smoke mapped ${mapped.features} features (${cudaFeatures.length} CUDA)`,
  );
}
function packFilename(output) {
  // npm <=11 returns an array; npm 12 keys pack results by package name.
  const result = Array.isArray(output)
    ? output[0]
    : output?.filename
      ? output
      : Object.values(output ?? {})[0];
  const filename = result?.filename;
  if (typeof filename !== "string" || filename.length === 0) {
    throw new Error("npm pack did not report a tarball filename");
  }
  return filename;
}

function packPath(destination, output) {
  const filename = packFilename(output);
  return isAbsolute(filename) ? filename : join(destination, filename);
}

function runtimeDependencyPaths(rootPath = root) {
  const packageJson = JSON.parse(readFileSync(join(rootPath, "package.json"), "utf8"));
  return runtimeDependencyNames(packageJson).map((name) =>
    dirname(moduleRequire.resolve(`${name}/package.json`)),
  );
}

function runtimeDependencyNames(packageJson) {
  return Object.keys(packageJson.dependencies ?? {});
}

function runtimeDependencyTarballs(context) {
  return runtimeDependencyPaths(context.root).map((dependencyPath) =>
    packDependency(context, dependencyPath),
  );
}

function packDependency(context, dependencyPath) {
  const packOutput = JSON.parse(
    run(
      context,
      "pnpm",
      packDependencyArgs({
        dependencyPath,
        destination: context.tmp,
      }),
      {
        stdio: "pipe",
      },
    ),
  );
  return packPath(context.tmp, packOutput);
}

function packDependencyArgs({ dependencyPath, destination }) {
  return [
    "--dir",
    dependencyPath,
    "--config.ignore-scripts=true",
    "pack",
    "--json",
    "--pack-destination",
    destination,
  ];
}

function installArgs({ installRoot, npmCache, tarball, dependencyTarballs }) {
  return [
    "install",
    "--offline",
    "--omit=dev",
    "--cache",
    npmCache,
    "--prefix",
    installRoot,
    tarball,
    ...dependencyTarballs,
  ];
}

function verifyRuntimeDependencies(context) {
  const packageJson = JSON.parse(readFileSync(join(context.root, "package.json"), "utf8"));
  const packageRoot = join(context.installRoot, "node_modules", packageJson.name);
  for (const name of runtimeDependencyNames(packageJson)) {
    run(context, "node", [
      "-e",
      "require.resolve(`${process.argv[1]}/package.json`, { paths: [process.argv[2]] })",
      name,
      packageRoot,
    ]);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}

export const packageSmokeTestHooks = {
  installArgs,
  packDependencyArgs,
  runtimeDependencyNames,
};
