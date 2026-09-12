import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { detectProject } from "./detect.js";
import { mapFeatures } from "./mapper.js";
import { discoverNodeProjects, scriptCommand } from "./mappers/projects.js";
import { turboTaskGraph } from "./mappers/turbo.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";
import * as projectsModule from "./mappers/projects.js";
import * as turboModule from "./mappers/turbo.js";

describe("mapFeatures", () => {
  it("quotes dynamic Node validation command parts", () => {
    expect(scriptCommand("pnpm", "packages/app; touch INJECTED", "test")).toBe(
      'pnpm --dir "packages/app; touch INJECTED" test',
    );
    expect(scriptCommand("npm", ".", "test:unit; touch INJECTED")).toBe(
      'npm run "test:unit; touch INJECTED"',
    );
    expect(scriptCommand("npm", "apps/site $(touch INJECTED)", "test")).toBe(
      'npm --prefix "apps/site \\$(touch INJECTED)" run test',
    );
  });

  it("applies configured path excludes to heuristic feature mapping", async () => {
    const root = await fixtureRoot("clawpatch-map-exclude-");
    await writeFixture(root, "requirements.txt", "pytest\n");
    await writeFixture(root, "src/app/api_service.py", "def call_api(): pass\n");
    for (let index = 0; index < 13; index += 1) {
      await writeFixture(
        root,
        `src/client/generated/models/model_${index}.py`,
        `class Model${index}: pass\n`,
      );
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, [], {
      filters: {
        include: ["**/*"],
        exclude: ["src/client/generated/**"],
      },
    });
    const featurePaths = result.features.flatMap((feature) => [
      ...feature.entrypoints.map((entrypoint) => entrypoint.path),
      ...feature.ownedFiles.map((file) => file.path),
      ...feature.contextFiles.map((file) => file.path),
      ...feature.tests.map((test) => test.path),
    ]);

    expect(featurePaths).toContain("src/app/api_service.py");
    expect(result.features.some((feature) => feature.title.includes("generated"))).toBe(false);
    expect(featurePaths.some((path) => path.startsWith("src/client/generated/"))).toBe(false);
  });

  it("maps package bins, scripts, configs, and Next routes", async () => {
    const root = await fixtureRoot("clawpatch-map-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          bin: { fixture: "src/Core.ts" },
          scripts: { build: "tsc", test: "vitest run" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(root, "src/Core.ts", "export function main() {}\n");
    await writeFixture(root, "Tests/CoreTests/CoreTests.swift", "import Testing\n");
    await writeFixture(root, "tests/core.rs", "#[test]\nfn core() {}\n");
    await writeFixture(
      root,
      "app/users/[id]/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "app/users/[id]/page.test.tsx", "test('route', () => {});\n");
    await writeFixture(
      root,
      "app/target/page.tsx",
      "export default function TargetPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "app/fixtures/page.tsx",
      "export default function FixturesPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "scripts/check-status.sh",
      'status="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || echo 000)"\n',
    );
    await writeFixture(
      root,
      "bin/check-status",
      [
        "#!/usr/bin/env bash",
        'status="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || echo 000)"',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      ".github/workflows/status.yml",
      [
        "name: status",
        "jobs:",
        "  check:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: |",
        '          status="$(curl -sS -o /dev/null -w "%{http_code}" "$url" || echo 000)"',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(result.created).toBeGreaterThanOrEqual(4);
    expect(titles).toContain("CLI command fixture");
    expect(titles).toContain("Package script build");
    expect(titles).toContain("Package script test");
    expect(titles).toContain("Route /users/:id");
    expect(titles).toContain("Route /target");
    expect(titles).toContain("Route /fixtures");
    expect(titles).toContain("Shell/workflow config check-status");
    expect(titles).toContain("Shell/workflow config check-status.sh");
    expect(titles).toContain("Shell/workflow config status.yml");
    expect(
      result.features.find((feature) => feature.title === "Shell/workflow config check-status.sh"),
    ).toMatchObject({
      source: "shell-workflow-heuristic",
      tags: expect.arrayContaining(["config", "shell", "workflow"]),
      trustBoundaries: expect.arrayContaining(["process-exec", "network"]),
      ownedFiles: [{ path: "scripts/check-status.sh", reason: expect.any(String) }],
    });
    expect(
      result.features.find((feature) => feature.title === "CLI command fixture")?.tests,
    ).toEqual([]);
    expect(result.features.find((feature) => feature.title === "Route /users/:id")?.tests).toEqual([
      { path: "app/users/[id]/page.test.tsx", command: "npm run test" },
    ]);
  });

  it("uses package-local commands when no task graph adapter is present", async () => {
    const root = await fixtureRoot("clawpatch-task-graph-fallback-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run", build: "next build" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");

    expect(route?.tests).toEqual([
      { path: "apps/web/app/page.test.tsx", command: "pnpm --dir apps/web test" },
    ]);
  });

  it("quotes workspace package roots with shell metacharacters in mapped validation commands", async () => {
    const root = await fixtureRoot("clawpatch-task-graph-fallback-quoted-");
    const packageRoot = "apps/web; touch INJECTED";
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      `${packageRoot}/package.json`,
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run", build: "next build" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      `${packageRoot}/app/page.tsx`,
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, `${packageRoot}/app/page.test.tsx`, "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");

    expect(route?.tests).toEqual([
      {
        path: `${packageRoot}/app/page.test.tsx`,
        command: 'pnpm --dir "apps/web; touch INJECTED" test',
      },
    ]);
  });

  it("uses bun workspace commands when the root has a text bun lockfile", async () => {
    const root = await fixtureRoot("clawpatch-task-graph-bun-lock-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "bun@1.3.3",
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "bun.lock", "");
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run", build: "next build" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");

    expect(project.detected.packageManagers).toContain("bun");
    expect(project.detected.commands.test).toBeNull();
    expect(route?.tests).toEqual([
      { path: "apps/web/app/page.test.tsx", command: "bun --cwd apps/web run test" },
    ]);
  });

  it("keeps Nx target commands on the workspace package manager", async () => {
    const root = await fixtureRoot("clawpatch-map-nx-root-package-manager-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify({ name: "web", sourceRoot: "apps/web/src", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        { name: "web", scripts: { test: "vitest run" }, dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(root, "apps/web/package-lock.json", "{}\n");
    await writeFixture(
      root,
      "apps/web/src/app/home/page.tsx",
      "export default function Home() { return null; }\n",
    );
    await writeFixture(root, "apps/web/src/app/home/page.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /home");

    expect(route?.tests).toEqual([
      { path: "apps/web/src/app/home/page.test.tsx", command: "pnpm nx test web" },
    ]);
  });

  it("uses Nx target commands for React route tests", async () => {
    const root = await fixtureRoot("clawpatch-map-react-nx-test-command-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify({ name: "web", sourceRoot: "apps/web/src", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        { name: "web", dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/web/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "apps/web/src/pages/HomePage.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "React route /home");

    expect(route?.tests).toEqual([
      { path: "apps/web/src/pages/HomePage.test.tsx", command: "pnpm nx test web" },
    ]);
  });

  it("uses Turbo task commands for React route tests", async () => {
    const root = await fixtureRoot("clawpatch-map-react-turbo-test-command-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - apps/*\n");
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(root, "turbo.json", JSON.stringify({ tasks: { test: {} } }, null, 2));
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/web/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "apps/web/src/pages/HomePage.test.tsx", "test('home', () => {});\n");

    const projectsSpy = vi.spyOn(projectsModule, "discoverNodeProjects");
    const taskGraphSpy = vi.spyOn(turboModule, "turboTaskGraph");
    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "React route /home");

    expect(route?.tests).toEqual([
      { path: "apps/web/src/pages/HomePage.test.tsx", command: "pnpm turbo run test --filter web" },
    ]);
    expect(projectsSpy).toHaveBeenCalledTimes(1);
    expect(taskGraphSpy).toHaveBeenCalledTimes(1);
  });

  it("suppresses fallback validation commands for persistent Turbo tasks", async () => {
    const root = await fixtureRoot("clawpatch-turbo-persistent-task-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "pnpm@10.0.0",
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "turbo.json",
      JSON.stringify({ tasks: { test: { cache: false, persistent: true } } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest --watch" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");
    const webPackage = result.features.find((feature) => feature.title === "Node package web");
    const webTestScript = result.features.find(
      (feature) => feature.title === "Package script test (web)",
    );

    expect(route?.tests).toEqual([{ path: "apps/web/app/page.test.tsx", command: null }]);
    expect(route?.tags).toContain("validation:test-suppressed");
    expect(webPackage?.tags).toContain("validation:test-suppressed");
    expect(webTestScript?.tags).toContain("validation:test-suppressed");
  });

  it("maps generated package bins back to source entries", async () => {
    const root = await fixtureRoot("clawpatch-map-bin-source-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "fixture-cli", bin: { fixture: "./dist/cli.js" } }, null, 2),
    );
    await writeFixture(root, "dist/cli.js", "#!/usr/bin/env node\n");
    await writeFixture(root, "src/cli.ts", "export function main() {}\n");
    await writeFixture(root, "src/cli.test.ts", "test('cli', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "CLI command fixture");

    expect(cli?.entrypoints[0]?.path).toBe("src/cli.ts");
    expect(cli?.ownedFiles).toContainEqual({ path: "src/cli.ts", reason: "entrypoint" });
    expect(cli?.tests).toEqual([{ path: "src/cli.test.ts", command: null }]);
    expect(cli?.summary).toContain("source src/cli.ts");
  });

  it("keeps generated package bins out of owned files when source is missing", async () => {
    const root = await fixtureRoot("clawpatch-map-bin-generated-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "fixture-cli", bin: { fixture: "./dist/cli.js" } }, null, 2),
    );
    await writeFixture(root, "dist/cli.js", "#!/usr/bin/env node\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "CLI command fixture");

    expect(cli?.entrypoints[0]?.path).toBe("package.json");
    expect(cli?.ownedFiles).toEqual([
      { path: "package.json", reason: "package manifest declaring generated bin" },
    ]);
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("dist/cli.js");
  });

  it("maps generated module and declaration entries back to source files", async () => {
    const root = await fixtureRoot("clawpatch-map-bin-module-source-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "module-cli",
          exports: { ".": "./dist/index.js", "./types": "./dist/types.d.ts" },
          bin: {
            esm: "./dist/esm.mjs",
            cjs: "./dist/cjs.cjs",
            pureEsm: "./dist/pure-esm.mjs",
            pureCjs: "./dist/pure-cjs.cjs",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "src/esm.mts", "export function esm() {}\n");
    await writeFixture(root, "src/cjs.cts", "export function cjs() {}\n");
    await writeFixture(root, "src/pure-esm.mjs", "export function pureEsm() {}\n");
    await writeFixture(root, "src/pure-cjs.cjs", "exports.pureCjs = true;\n");
    await writeFixture(root, "src/index.tsx", "export function Index() { return null; }\n");
    await writeFixture(root, "src/types.ts", "export type Fixture = string;\n");
    await writeFixture(root, "dist/esm.mjs", "export {};\n");
    await writeFixture(root, "dist/cjs.cjs", "module.exports = {};\n");
    await writeFixture(root, "dist/pure-esm.mjs", "export {};\n");
    await writeFixture(root, "dist/pure-cjs.cjs", "module.exports = {};\n");
    await writeFixture(root, "dist/index.js", "export {};\n");
    await writeFixture(root, "dist/types.d.ts", "export type Fixture = string;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const esm = result.features.find((feature) => feature.title === "CLI command esm");
    const cjs = result.features.find((feature) => feature.title === "CLI command cjs");
    const pureEsm = result.features.find((feature) => feature.title === "CLI command pureEsm");
    const pureCjs = result.features.find((feature) => feature.title === "CLI command pureCjs");
    const nodePackage = result.features.find(
      (feature) => feature.title === "Node package module-cli",
    );

    expect(esm?.entrypoints[0]?.path).toBe("src/esm.mts");
    expect(cjs?.entrypoints[0]?.path).toBe("src/cjs.cts");
    expect(pureEsm?.entrypoints[0]?.path).toBe("src/pure-esm.mjs");
    expect(pureCjs?.entrypoints[0]?.path).toBe("src/pure-cjs.cjs");
    expect(esm?.ownedFiles).toEqual([{ path: "src/esm.mts", reason: "entrypoint" }]);
    expect(cjs?.ownedFiles).toEqual([{ path: "src/cjs.cts", reason: "entrypoint" }]);
    expect(nodePackage?.contextFiles).toContainEqual({
      path: "src/index.tsx",
      reason: "package entrypoint",
    });
    expect(nodePackage?.contextFiles).toContainEqual({
      path: "src/types.ts",
      reason: "package entrypoint",
    });
    expect(nodePackage?.contextFiles).not.toContainEqual({
      path: "dist/index.js",
      reason: "package entrypoint",
    });
  });

  it("maps workspace packages and splits large Node source groups", async () => {
    const root = await fixtureRoot("clawpatch-node-workspace-map-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          scripts: { test: "vitest run" },
          workspaces: [
            "*",
            "packages/*",
            "packages/**/plugins/*",
            "packages/*/examples/*",
            "plugins/*",
            "../*",
            "linked-pkg",
            "linked/*",
          ],
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "pnpm-workspace.yaml",
      "packages:\n  - packages/*\n  - packages/**/plugins/*\n  - plugins/*\n  - '!packages/legacy'\n  - '!packages/*/examples/ignored'\n",
    );
    await writeFixture(
      root,
      "packages/core/package.json",
      JSON.stringify(
        {
          name: "@scope/core",
          bin: { corecli: "src/cli.ts" },
          scripts: {
            build: "tsc -p tsconfig.json",
            lint: "oxlint .",
            test: "vitest run",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "packages/core/AGENTS.md", "Core package notes.\n");
    await writeFixture(root, "packages/core/src/cli.ts", "export function main() {}\n");
    await writeFixture(root, "packages/core/src/cli.test.ts", "test('cli', () => {});\n");
    for (let index = 0; index < 14; index += 1) {
      await writeFixture(
        root,
        `packages/core/src/agents/file${String(index).padStart(2, "0")}.ts`,
        `export const value${index} = ${index};\n`,
      );
    }
    await writeFixture(
      root,
      "packages/core/src/gateway/gateway.ts",
      "export function gateway() {}\n",
    );
    await writeFixture(
      root,
      "packages/core/src/gateway/gateway.test.ts",
      "import { gateway } from './gateway';\n",
    );
    await writeFixture(
      root,
      "plugins/chat/package.json",
      JSON.stringify({ name: "chat-plugin" }, null, 2),
    );
    await writeFixture(root, "plugins/chat/src/index.ts", "export function activate() {}\n");
    await writeFixture(
      root,
      "packages/core/examples/demo/package.json",
      JSON.stringify({ name: "demo-example" }, null, 2),
    );
    await writeFixture(
      root,
      "packages/core/examples/demo/src/index.ts",
      "export function demo() {}\n",
    );
    await writeFixture(
      root,
      "packages/core/nested/plugins/worker/package.json",
      JSON.stringify({ name: "worker-plugin" }, null, 2),
    );
    await writeFixture(
      root,
      "packages/core/nested/plugins/worker/src/index.ts",
      "export function worker() {}\n",
    );
    await writeFixture(
      root,
      "packages/core/examples/ignored/package.json",
      JSON.stringify({ name: "ignored-example" }, null, 2),
    );
    await writeFixture(
      root,
      "packages/core/examples/ignored/src/index.ts",
      "export function ignored() {}\n",
    );
    await writeFixture(root, "tools/package.json", JSON.stringify({ name: "root-tool" }, null, 2));
    await writeFixture(root, "tools/src/index.ts", "export function tool() {}\n");
    await writeFixture(
      root,
      "packages/legacy/package.json",
      JSON.stringify({ name: "legacy-package" }, null, 2),
    );
    await writeFixture(root, "packages/legacy/src/index.ts", "export function legacy() {}\n");
    await writeFixture(
      root,
      "../outside-workspace/package.json",
      JSON.stringify({ name: "outside-workspace" }, null, 2),
    );
    await writeFixture(root, "../outside-workspace/src/index.ts", "export function outside() {}\n");
    await writeFixture(
      root,
      "../outside-workspace/evil/package.json",
      JSON.stringify({ name: "evil-package" }, null, 2),
    );
    await writeFixture(
      root,
      "../outside-workspace/evil/src/index.ts",
      "export function evil() {}\n",
    );
    if (process.platform !== "win32") {
      await symlink(join(root, "../outside-workspace"), join(root, "linked-pkg"), "dir");
      await symlink(join(root, "../outside-workspace"), join(root, "linked"), "dir");
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const agentGroups = result.features.filter(
      (feature) =>
        feature.source === "node-source-group" &&
        feature.entrypoints[0]?.symbol?.startsWith("packages/core/src/agents") === true,
    );
    const gateway = result.features.find(
      (feature) => feature.entrypoints[0]?.symbol === "packages/core/src/gateway",
    );
    const cli = result.features.find((feature) => feature.title === "CLI command corecli");
    const workspaceBuild = result.features.find(
      (feature) => feature.title === "Package script build (@scope/core)",
    );
    const workspaceLint = result.features.find(
      (feature) => feature.title === "Package script lint (@scope/core)",
    );
    const workspaceTest = result.features.find(
      (feature) => feature.title === "Package script test (@scope/core)",
    );

    expect(titles).toContain("Node package @scope/core");
    expect(titles).toContain("Node package chat-plugin");
    expect(titles).toContain("Node package demo-example");
    expect(titles).toContain("Node package worker-plugin");
    expect(titles).toContain("Node package root-tool");
    expect(titles).not.toContain("Node package legacy-package");
    expect(titles).not.toContain("Node package ignored-example");
    expect(titles).not.toContain("Node package outside-workspace");
    expect(titles).not.toContain("Node package evil-package");
    expect(titles).toContain("Node source plugins/chat/src");
    expect(titles).toContain("Package script test");
    expect(workspaceBuild?.entrypoints[0]?.path).toBe("packages/core/package.json");
    expect(workspaceBuild?.summary).toContain("packages/core/package.json");
    expect(workspaceLint?.entrypoints[0]?.path).toBe("packages/core/package.json");
    expect(workspaceTest?.entrypoints[0]?.path).toBe("packages/core/package.json");
    expect(agentGroups.length).toBeGreaterThan(1);
    expect(agentGroups.every((feature) => feature.ownedFiles.length <= 12)).toBe(true);
    expect(gateway?.ownedFiles).toEqual([
      {
        path: "packages/core/src/gateway/gateway.ts",
        reason: "source group packages/core/src/gateway",
      },
    ]);
    expect(gateway?.tests).toEqual([
      {
        path: "packages/core/src/gateway/gateway.test.ts",
        command: "pnpm --dir packages/core test",
      },
    ]);
    expect(cli?.tests).toEqual([
      { path: "packages/core/src/cli.test.ts", command: "pnpm --dir packages/core test" },
    ]);
    expect(
      result.features.find((feature) => feature.title === "Node package @scope/core")?.contextFiles,
    ).toContainEqual({ path: "packages/core/AGENTS.md", reason: "package context" });
    expect(project.detected.packageManagers).toContain("pnpm");
  });

  it("maps workspace package metadata, entries, tests, and docs as package context", async () => {
    const root = await fixtureRoot("clawpatch-node-package-context-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await writeFixture(
      root,
      "packages/core/package.json",
      JSON.stringify(
        {
          name: "@scope/core",
          exports: { ".": "./dist/index.js", "./worker": { types: "./dist/worker.d.ts" } },
          scripts: { test: "vitest run" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "packages/core/tsconfig.json", "{}\n");
    await writeFixture(root, "packages/core/vitest.config.ts", "export default {};\n");
    await writeFixture(root, "packages/core/README.md", "# core\n");
    await writeFixture(root, "packages/core/src/index.ts", "export const core = true;\n");
    await writeFixture(root, "packages/core/src/worker.ts", "export const worker = true;\n");
    await writeFixture(root, "packages/core/src/index.test.ts", "import './index';\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const core = result.features.find((feature) => feature.title === "Node package @scope/core");

    expect(core?.ownedFiles).toEqual([
      { path: "packages/core/package.json", reason: "package manifest" },
      { path: "packages/core/tsconfig.json", reason: "typescript configuration" },
      { path: "packages/core/vitest.config.ts", reason: "test configuration" },
    ]);
    expect(core?.contextFiles).toContainEqual({
      path: "packages/core/README.md",
      reason: "package context",
    });
    expect(core?.contextFiles).toContainEqual({
      path: "packages/core/src/index.ts",
      reason: "package entrypoint",
    });
    expect(core?.contextFiles).toContainEqual({
      path: "packages/core/src/index.test.ts",
      reason: "package test",
    });
  });

  it("maps extension packages generically and semantically splits large flat source folders", async () => {
    const root = await fixtureRoot("clawpatch-node-extension-map-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - extensions/*\n");
    await writeFixture(
      root,
      "extensions/chat/package.json",
      JSON.stringify(
        {
          name: "chat-extension",
          exports: { ".": "./dist/index.js" },
          scripts: { test: "vitest" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "extensions/chat/README.md", "# chat\n");
    await writeFixture(root, "extensions/chat/src/index.ts", "export const chat = true;\n");
    await writeFixture(root, "extensions/chat/src/runtime.ts", "export const runtime = true;\n");
    await writeFixture(root, "extensions/chat/src/runtime.test.ts", "import './runtime';\n");
    for (let index = 0; index < 13; index += 1) {
      await writeFixture(
        root,
        `extensions/chat/src/auth-${String(index).padStart(2, "0")}.ts`,
        `export const auth${index} = true;\n`,
      );
    }
    for (let index = 0; index < 13; index += 1) {
      await writeFixture(
        root,
        `extensions/chat/src/storage-${String(index).padStart(2, "0")}.ts`,
        `export const storage${index} = true;\n`,
      );
    }
    await writeFixture(root, "extensions/chat/dist/index.js", "export {};\n");
    await writeFixture(
      root,
      "extensions/chat/src/generated/schema.ts",
      "export const skip = true;\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const extension = result.features.find(
      (feature) => feature.title === "Node package chat-extension",
    );
    const auth = result.features.find(
      (feature) => feature.entrypoints[0]?.symbol === "extensions/chat/src/:auth#1",
    );
    const storage = result.features.find(
      (feature) => feature.entrypoints[0]?.symbol === "extensions/chat/src/:storage#1",
    );
    const owned = result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path));

    expect(extension?.source).toBe("node-extension-package");
    expect(extension?.tags).toContain("extension-package");
    expect(extension?.contextFiles).toContainEqual({
      path: "extensions/chat/src/index.ts",
      reason: "package entrypoint",
    });
    expect(auth?.ownedFiles).toHaveLength(12);
    expect(storage?.ownedFiles).toHaveLength(12);
    expect(owned).not.toContain("extensions/chat/dist/index.js");
    expect(owned).not.toContain("extensions/chat/src/generated/schema.ts");
  });

  it("keeps nested source directories when semantic file labels overlap", async () => {
    const root = await fixtureRoot("clawpatch-node-semantic-shadow-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "shadow" }, null, 2));
    await writeFixture(root, "src/auth.ts", "export const auth = true;\n");
    await writeFixture(root, "src/auth/login.ts", "export const login = true;\n");
    await writeFixture(root, "src/auth/token.ts", "export const token = true;\n");
    await writeFixture(root, "src/auth-files/real.ts", "export const real = true;\n");
    for (let index = 0; index < 11; index += 1) {
      await writeFixture(
        root,
        `src/other/file-${String(index).padStart(2, "0")}.ts`,
        `export const other${index} = true;\n`,
      );
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const sourceGroups = result.features.filter(
      (feature) => feature.source === "node-source-group",
    );
    const owned = sourceGroups.flatMap((feature) => feature.ownedFiles.map((file) => file.path));

    expect(sourceGroups.map((feature) => feature.entrypoints[0]?.symbol)).toContain("src/:auth");
    expect(sourceGroups.map((feature) => feature.entrypoints[0]?.symbol)).toContain("src/auth");
    expect(sourceGroups.map((feature) => feature.entrypoints[0]?.symbol)).toContain(
      "src/auth-files",
    );
    expect(owned).toContain("src/auth.ts");
    expect(owned).toContain("src/auth/login.ts");
    expect(owned).toContain("src/auth/token.ts");
    expect(owned).toContain("src/auth-files/real.ts");
  });

  it("maps pnpm workspace packages without a root package manifest", async () => {
    const root = await fixtureRoot("clawpatch-pnpm-workspace-only-map-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await writeFixture(
      root,
      "packages/core/package.json",
      JSON.stringify({ name: "@scope/core", scripts: { test: "vitest run" } }, null, 2),
    );
    await writeFixture(root, "packages/core/src/index.ts", "export const core = true;\n");
    await writeFixture(root, "packages/core/src/index.test.ts", "import './index';\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("pnpm");
    expect(titles).toContain("Node package @scope/core");
    expect(titles).toContain("Node source packages/core/src");
    expect(
      result.features.find((feature) => feature.title === "Node source packages/core/src")?.tests,
    ).toEqual([
      { path: "packages/core/src/index.test.ts", command: "pnpm --dir packages/core test" },
    ]);
  });

  it("parses Turbo task metadata for workspace validation commands", async () => {
    const root = await fixtureRoot("clawpatch-turbo-task-graph-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "pnpm@10.0.0",
          workspaces: ["apps/*", "packages/*"],
          scripts: { test: "vitest run root.test.ts" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify({ name: "web-app", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "turbo.json",
      JSON.stringify(
        {
          globalDependencies: ["package.json", "pnpm-lock.yaml"],
          globalEnv: ["NODE_ENV"],
          tasks: {
            build: { dependsOn: ["^build"], outputs: ["dist/**", ".next/**"] },
            "@scope/web#test": { dependsOn: ["^test"], outputs: ["coverage/**"] },
            lint: {},
            dev: { cache: false, persistent: true },
            "@scope/ext#build": {
              dependsOn: ["@scope/contracts#build"],
              outputs: ["dist/**"],
            },
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "apps/web/package-lock.json", "{}\n");
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "@scope/web",
          scripts: { build: "next build", test: "vitest run", lint: "biome check ." },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "packages/contracts/package.json",
      JSON.stringify(
        { name: "@scope/contracts", scripts: { build: "tsc -p tsconfig.json" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/ext/package.json",
      JSON.stringify({ name: "@scope/ext", scripts: { build: "vite build" } }, null, 2),
    );

    const projects = await discoverNodeProjects(root);
    const graph = await turboTaskGraph(root, projects);
    const webTest = graph.commands.find(
      (command) => command.projectRoot === "apps/web" && command.task === "test",
    );
    const extBuild = graph.commands.find(
      (command) => command.projectName === "@scope/ext" && command.task === "build",
    );

    expect(graph.runner).toBe("turbo");
    expect(graph.globalDependencies).toEqual(["package.json", "pnpm-lock.yaml"]);
    expect(graph.globalEnv).toEqual(["NODE_ENV"]);
    expect(webTest?.projectName).toBe("web-app");
    expect(webTest?.command).toBe("pnpm turbo run test --filter @scope/web");
    expect(webTest?.metadata.dependsOn).toEqual(["^test"]);
    expect(extBuild?.command).toBe("pnpm turbo run build --filter @scope/ext");
    expect(extBuild?.metadata.dependsOn).toEqual(["@scope/contracts#build"]);
    expect(graph.commands.some((command) => command.task === "dev")).toBe(false);
    expect(
      graph.commands.some(
        (command) => command.projectName === "@scope/contracts" && command.task === "test",
      ),
    ).toBe(false);
    expect(graph.commands.some((command) => command.projectRoot === ".")).toBe(false);
  });

  it("uses Turbo task commands for mapped workspace feature validation", async () => {
    const root = await fixtureRoot("clawpatch-turbo-feature-validation-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "pnpm@10.0.0",
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "turbo.json",
      JSON.stringify({ tasks: { test: { dependsOn: ["^test"] } } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");
    const webSource = result.features.find(
      (feature) => feature.title === "Node source apps/web/app",
    );

    expect(route?.tests).toEqual([
      { path: "apps/web/app/page.test.tsx", command: "pnpm turbo run test --filter web" },
    ]);
    expect(webSource?.tests).toEqual([
      { path: "apps/web/app/page.test.tsx", command: "pnpm turbo run test --filter web" },
    ]);
  });

  it("quotes Turbo task filters with shell metacharacters", async () => {
    const root = await fixtureRoot("clawpatch-turbo-quoted-filter-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "pnpm@10.0.0",
          workspaces: ["apps/*"],
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(root, "turbo.json", JSON.stringify({ tasks: { test: {} } }, null, 2));
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web; touch INJECTED",
          scripts: { test: "vitest run" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const mappedTest = result.features
      .flatMap((feature) => feature.tests)
      .find((test) => test.path === "apps/web/app/page.test.tsx");

    expect(mappedTest).toEqual({
      path: "apps/web/app/page.test.tsx",
      command: 'pnpm turbo run test --filter "web; touch INJECTED"',
    });
  });

  it("keeps package-local validation for fallback packages outside the workspace graph", async () => {
    const root = await fixtureRoot("clawpatch-turbo-non-workspace-package-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "workspace-root",
          packageManager: "pnpm@10.0.0",
          workspaces: ["packages/*"],
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(root, "turbo.json", JSON.stringify({ tasks: { test: {} } }, null, 2));
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify(
        {
          name: "web",
          scripts: { test: "vitest run" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/app/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(root, "apps/web/app/page.test.tsx", "test('page', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /");

    expect(route?.tests).toEqual([
      { path: "apps/web/app/page.test.tsx", command: "pnpm --dir apps/web test" },
    ]);
  });

  it("maps turbo config and skips versioned virtualenv directories", async () => {
    const root = await fixtureRoot("clawpatch-turbo-config-venv-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "root" }, null, 2));
    await writeFixture(root, "turbo.json", JSON.stringify({ tasks: { test: {} } }, null, 2));
    await writeFixture(root, "apps/sandbox/pyproject.toml", "[project]\nname = 'sandbox'\n");
    await writeFixture(
      root,
      "apps/sandbox/src/main.py",
      "from fastapi import FastAPI\napp = FastAPI()\n",
    );
    await writeFixture(
      root,
      "apps/sandbox/.venv-311/lib/python/site-packages/bad.py",
      "raise RuntimeError()\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const ownedPaths = result.features.flatMap((feature) =>
      feature.ownedFiles.map((file) => file.path),
    );

    expect(titles).toContain("Project config turbo.json");
    expect(ownedPaths.some((path) => path.includes(".venv-311"))).toBe(false);
  });

  it("uses package-local locks for fallback Node package roots", async () => {
    const root = await fixtureRoot("clawpatch-node-fallback-package-lock-");
    await writeFixture(
      root,
      "frontend/package.json",
      JSON.stringify({ name: "frontend", scripts: { test: "vitest run" } }, null, 2),
    );
    await writeFixture(root, "frontend/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await writeFixture(root, "frontend/src/index.ts", "export const frontend = true;\n");
    await writeFixture(root, "frontend/src/index.test.ts", "import './index';\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.find((feature) => feature.title === "Node source frontend/src")?.tests,
    ).toEqual([{ path: "frontend/src/index.test.ts", command: "pnpm --dir frontend test" }]);
  });

  it("uses package-local pnpm workspace markers for fallback Node package roots", async () => {
    const root = await fixtureRoot("clawpatch-node-fallback-package-workspace-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "root", scripts: { test: "node root.test.js" } }, null, 2),
    );
    await writeFixture(root, "package-lock.json", "{}\n");
    await writeFixture(
      root,
      "frontend/package.json",
      JSON.stringify({ name: "frontend", scripts: { test: "vitest run" } }, null, 2),
    );
    await writeFixture(root, "frontend/pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await writeFixture(root, "frontend/src/index.ts", "export const frontend = true;\n");
    await writeFixture(root, "frontend/src/index.test.ts", "import './index';\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.find((feature) => feature.title === "Node source frontend/src")?.tests,
    ).toEqual([{ path: "frontend/src/index.test.ts", command: "pnpm --dir frontend test" }]);
  });

  it("maps nested SwiftPM, Apple, and Android Gradle app surfaces", async () => {
    const root = await fixtureRoot("clawpatch-native-app-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "native-root" }, null, 2));
    await writeFixture(
      root,
      "apps/macos/Package.swift",
      [
        "// swift-tools-version: 6.0",
        "import PackageDescription",
        "let package = Package(",
        '  name: "MacApp",',
        '  targets: [.executableTarget(name: "MacApp"), .testTarget(name: "MacAppTests", dependencies: ["MacApp"])]',
        ")",
      ].join("\n"),
    );
    await writeFixture(root, "apps/macos/Sources/MacApp/main.swift", "@main struct App {}\n");
    await writeFixture(root, "apps/macos/Tests/MacAppTests/MacAppTests.swift", "import Testing\n");
    await writeFixture(root, "apps/ios/project.yml", "name: MobileApp\n");
    await writeFixture(root, "apps/ios/Sources/App.swift", "@main struct MobileApp {}\n");
    await writeFixture(
      root,
      "apps/ios/ShareExtension/ShareViewController.swift",
      "final class ShareViewController {}\n",
    );
    await writeFixture(root, "apps/ios/Tests/AppTests.swift", "import Testing\n");
    await writeFixture(root, "apps/ios/Pods/Vendor.swift", "struct Vendor {}\n");
    await writeFixture(
      root,
      "apps/ios/SourcePackages/checkouts/Dependency/Dep.swift",
      "struct Dep {}\n",
    );
    await writeFixture(
      root,
      "apps/ios/SourcePackages/checkouts/Dependency/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Dependency")\n',
    );
    await writeFixture(root, "apps/android/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "apps/android/build.gradle.kts",
      'plugins { id("com.android.application") version "1.0" apply false }\n',
    );
    await writeFixture(
      root,
      "apps/android/app/build.gradle.kts",
      'plugins { id("com.android.application") }\n',
    );
    await writeFixture(root, "apps/android/app/src/main/AndroidManifest.xml", "<manifest />\n");
    await writeFixture(
      root,
      "apps/android/app/src/main/java/com/example/MainActivity.kt",
      "class MainActivity\n",
    );
    await writeFixture(
      root,
      "apps/android/app/src/test/java/com/example/MainActivityTest.kt",
      "class MainActivityTest\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const mac = result.features.find((feature) =>
      feature.title.startsWith("Swift executable MacApp"),
    );
    const ios = result.features.find(
      (feature) => feature.title === "Apple source apps/ios/Sources",
    );
    const android = result.features.find(
      (feature) => feature.title === "Gradle source apps/android/app/src",
    );

    expect(project.detected.languages).toContain("swift");
    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.packageManagers).toContain("swiftpm");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBeNull();
    expect(titles).toContain("Swift executable MacApp (apps/macos)");
    expect(titles).toContain("Apple project apps/ios");
    expect(titles).toContain("Apple source apps/ios/ShareExtension");
    expect(titles).toContain("Gradle module apps/android/app");
    expect(titles.some((title) => title.includes("Dependency"))).toBe(false);
    expect(mac?.entrypoints[0]?.path).toBe("apps/macos/Sources/MacApp/main.swift");
    expect(mac?.tests).toEqual([
      {
        path: "apps/macos/Tests/MacAppTests/MacAppTests.swift",
        command: "swift test --package-path apps/macos",
      },
    ]);
    expect(ios?.ownedFiles.map((file) => file.path)).toEqual(["apps/ios/Sources/App.swift"]);
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("apps/ios/Pods/Vendor.swift");
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("apps/ios/SourcePackages/checkouts/Dependency/Dep.swift");
    expect(android?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "apps/android/app/src/main/AndroidManifest.xml",
      "apps/android/app/src/main/java/com/example/MainActivity.kt",
    ]);
    expect(android?.tests).toEqual([
      { path: "apps/android/app/src/test/java/com/example/MainActivityTest.kt", command: null },
    ]);
  });

  it("ignores native sample projects under fixtures and testdata during detection", async () => {
    const root = await fixtureRoot("clawpatch-native-fixture-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(
      root,
      "tests/fixtures/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Fixture")\n',
    );
    await writeFixture(root, "tests/fixtures/Sources/Fixture/main.swift", "@main struct App {}\n");
    await writeFixture(root, "testdata/build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "testdata/src/main/java/com/example/App.kt", "class App\n");
    await writeFixture(root, "fixtures/ios/project.yml", "name: FixtureApp\n");
    await writeFixture(root, "fixtures/ios/Sources/App.swift", "@main struct App {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const nativeFeatures = result.features.filter(
      (feature) =>
        feature.source.startsWith("swift-") ||
        feature.source.startsWith("apple-") ||
        feature.source.startsWith("gradle-"),
    );

    expect(project.detected.languages).not.toContain("swift");
    expect(project.detected.languages).not.toContain("kotlin");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
    expect(project.detected.packageManagers).not.toContain("gradle");
    expect(nativeFeatures).toEqual([]);
  });

  it("keeps Node scripts and native defaults in mixed package repos", async () => {
    const root = await fixtureRoot("clawpatch-mixed-map-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "mixed", scripts: { lint: "oxlint" } }, null, 2),
    );
    await writeFixture(root, "go.mod", "module example.com/mixed\n");
    await writeFixture(root, "cmd/tool/main.go", "package main\nfunc main() {}\n");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "mixed"\n');
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");
    await writeFixture(root, "tests/integration.rs", "#[test]\nfn works() {}\n");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "mixed-py"\ndependencies = ["pytest"]\n',
    );
    await writeFixture(root, "scripts/tool.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.packageManagers).toEqual(["node", "cargo", "python"]);
    expect(project.detected.languages).toContain("python");
    expect(project.detected.commands.typecheck).toBe("go test ./...");
    expect(project.detected.commands.lint).toBe("npm run lint");
    expect(project.detected.commands.format).toBeNull();
    expect(project.detected.commands.test).toBe("go test ./...");
    expect(result.features.map((feature) => feature.title)).toContain("Python project mixed-py");
    expect(
      result.features.find((feature) => feature.title === "Rust library mixed")?.tests,
    ).toEqual([{ path: "tests/integration.rs", command: "cargo test --workspace" }]);
  });

  it("skips native build output during root test discovery", async () => {
    const root = await fixtureRoot("clawpatch-native-build-skip-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rootpkg"\n');
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(root, "target/Cargo.test.ts", "test('generated', () => {});\n");
    await writeFixture(root, ".build/Cargo.test.ts", "test('generated', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const config = result.features.find((feature) => feature.title === "Project config Cargo.toml");

    expect(config?.tests).toEqual([]);
  });

  it("does not block non-Node mappers on the fallback Node signal", async () => {
    const root = await fixtureRoot("clawpatch-map-node-signal-");
    await writeFixture(root, "go.mod", "module example.com/go-app\n");
    await writeFixture(root, "main.go", "package main\nfunc main() {}\n");
    const signal = Promise.withResolvers<boolean>();
    vi.spyOn(projectsModule, "hasFallbackNodeProjectSignal").mockReturnValue(signal.promise);
    const projectsSpy = vi.spyOn(projectsModule, "discoverNodeProjects");
    const goDone = Promise.withResolvers<void>();
    const project = await detectProject(root);

    const mapping = mapFeatures(root, project, [], {
      onProgress(event) {
        if (event.event === "mapper-done" && event.mapper === "go") {
          goDone.resolve();
        }
      },
    });
    await goDone.promise;

    expect(projectsSpy).not.toHaveBeenCalled();
    signal.resolve(false);
    await expect(mapping).resolves.toBeDefined();
  });

  it("preserves package-less Node projects under conventional roots", async () => {
    const root = await fixtureRoot("clawpatch-map-package-less-node-");
    await writeFixture(root, "apps/web/src/index.ts", "export function start() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.languages).not.toContain("typescript");
    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/web/src");
  });

  it("preserves package-less Nx projects outside conventional roots", async () => {
    const root = await fixtureRoot("clawpatch-map-package-less-nx-");
    await writeFixture(
      root,
      "tools/cli/project.json",
      JSON.stringify({ name: "cli", sourceRoot: "tools/cli/src" }),
    );
    await writeFixture(root, "tools/cli/src/index.ts", "export function main() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.languages).not.toContain("typescript");
    expect(result.features.map((feature) => feature.title)).toContain("Node source tools/cli/src");
  });

  it("propagates Turbo failures and retries with a fresh mapping context", async () => {
    const root = await fixtureRoot("clawpatch-map-turbo-failure-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "node-app" }));
    await writeFixture(root, "src/index.ts", "export const value = true;\n");
    await writeFixture(root, "turbo.json", "not-json\n");
    const taskGraphSpy = vi.spyOn(turboModule, "turboTaskGraph");
    const project = await detectProject(root);

    await expect(mapFeatures(root, project, [])).rejects.toThrow();
    await writeFixture(root, "turbo.json", JSON.stringify({ tasks: {} }));
    await expect(mapFeatures(root, project, [])).resolves.toBeDefined();

    expect(taskGraphSpy).toHaveBeenCalledTimes(2);
  });
});
