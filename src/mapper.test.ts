import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "./detect.js";
import { mapFeatures } from "./mapper.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";

describe("mapFeatures", () => {
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
    expect(
      result.features.find((feature) => feature.title === "CLI command fixture")?.tests,
    ).toEqual([]);
    expect(result.features.find((feature) => feature.title === "Route /users/:id")?.tests).toEqual([
      { path: "app/users/[id]/page.test.tsx", command: "npm run test" },
    ]);
  });

  it("maps Next routes under src/app and src/pages", async () => {
    const root = await fixtureRoot("clawpatch-map-next-src-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "fixture-app",
          scripts: { build: "next build" },
          dependencies: { next: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "tsconfig.json", "{}");
    await writeFixture(
      root,
      "src/app/dashboard/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/app/api/health/route.ts",
      "export function GET() { return new Response('ok'); }\n",
    );
    await writeFixture(
      root,
      "src/pages/about.tsx",
      "export default function About() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/docs/page.tsx",
      "export default function DocsPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/docs/route.tsx",
      "export default function DocsRoute() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/_app.tsx",
      "export default function App() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/_document.tsx",
      "export default function Document() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/_error.tsx",
      "export default function ErrorPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const bySource = (route: string) =>
      result.features.find((feature) => feature.title === `Route ${route}`)?.source;

    expect(titles).toContain("Route /dashboard");
    expect(titles).toContain("Route /api/health");
    expect(titles).toContain("Route /about");
    expect(titles).toContain("Route /docs/page");
    expect(titles).toContain("Route /docs/route");
    expect(bySource("/dashboard")).toBe("next-app-route");
    expect(bySource("/api/health")).toBe("next-app-route");
    expect(bySource("/about")).toBe("next-pages-route");
    expect(titles).not.toContain("Route /_app");
    expect(titles).not.toContain("Route /_document");
    expect(titles).not.toContain("Route /_error");
  });

  it("maps application routes in vendor directories", async () => {
    const root = await fixtureRoot("clawpatch-next-vendor-route-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "fixture-app", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "app/vendor/page.tsx",
      "export default function VendorPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Route /vendor");
  });

  it("does not map src app-shaped routes without a Next project signal", async () => {
    const root = await fixtureRoot("clawpatch-map-src-non-next-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "plain-app" }, null, 2));
    await writeFixture(
      root,
      "src/app/dashboard/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/about.tsx",
      "export default function About() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("Route /dashboard");
    expect(titles).not.toContain("Route /about");
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
    await symlink(join(root, "../outside-workspace"), join(root, "linked-pkg"), "dir");
    await symlink(join(root, "../outside-workspace"), join(root, "linked"), "dir");

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

  it("normalizes root Gradle source groups", async () => {
    const root = await fixtureRoot("clawpatch-root-gradle-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "src/main/java/com/example/App.kt", "class App\n");
    await writeFixture(root, "src/test/java/com/example/AppTest.kt", "class AppTest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Gradle source src");
    expect(titles).toContain("Gradle test suite src");
    expect(titles.some((title) => title.includes("./src"))).toBe(false);
    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.commands).toMatchObject({
      typecheck: "gradle build",
      test: "gradle test",
    });
  });

  it("detects Kotlin and Gradle commands for Groovy Gradle root projects", async () => {
    const root = await fixtureRoot("clawpatch-root-kotlin-gradle-detect-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "plugins { id 'org.jetbrains.kotlin.jvm' }\n");
    await writeFixture(root, "src/main/kotlin/com/example/app/App.kt", "class App\n");
    await writeFixture(root, "src/test/kotlin/com/example/app/AppTest.kt", "class AppTest\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands).toMatchObject({
      typecheck: "gradle build",
      test: "gradle test",
    });
  });

  it("detects Java and wrapper Gradle commands for root Gradle projects", async () => {
    const root = await fixtureRoot("clawpatch-root-java-gradle-detect-");
    await writeFixture(root, "gradlew", "#!/bin/sh\n");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "plugins { id 'java' }\n");
    await writeFixture(root, "src/main/java/com/example/App.java", "class App {}\n");
    await writeFixture(root, "src/test/java/com/example/AppTest.java", "class AppTest {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("java");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands).toMatchObject({
      typecheck: "./gradlew build",
      test: "./gradlew test",
    });
  });

  it("does not detect Java from documentation-only Java files", async () => {
    const root = await fixtureRoot("clawpatch-docs-java-detect-");
    await writeFixture(root, "docs/Example.java", "class Example {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("java");
  });

  it("maps build.gradle-only roots without empty Gradle groups", async () => {
    const root = await fixtureRoot("clawpatch-gradle-build-only-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "src/main/java/com/acme/test/Foo.kt", "class Foo\n");
    await writeFixture(root, "src/test/java/com/acme/FooTest.kt", "class FooTest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const gradleFeatures = result.features.filter((feature) =>
      feature.source.startsWith("gradle-"),
    );
    const source = result.features.find((feature) => feature.title === "Gradle source src");

    expect(gradleFeatures.length).toBeGreaterThan(0);
    expect(source?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/java/com/acme/test/Foo.kt",
    );
    expect(gradleFeatures.every((feature) => feature.ownedFiles.length > 0)).toBe(true);
  });

  it("maps nested build.gradle-only Gradle apps", async () => {
    const root = await fixtureRoot("clawpatch-nested-gradle-build-only-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/android/build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(root, "apps/android/src/main/java/com/example/App.kt", "class App\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("gradle");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBeNull();
    expect(titles).toContain("Gradle module apps/android");
    expect(titles).toContain("Gradle source apps/android/src");
  });

  it("maps JVM role features from Java code evidence", async () => {
    const root = await fixtureRoot("clawpatch-jvm-role-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(
      root,
      "src/main/java/com/acme/api/OrderController.java",
      [
        "package com.acme.api;",
        "",
        "import org.springframework.web.bind.annotation.GetMapping;",
        "import org.springframework.web.bind.annotation.RestController;",
        "",
        "@RestController",
        "public class OrderController {",
        '  @GetMapping("/orders")',
        '  public String list() { return "ok"; }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/app/BillingService.java",
      [
        "package com.acme.app;",
        "",
        "import org.springframework.stereotype.Service;",
        "",
        "@Service",
        "public class BillingService {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/db/OrderEntity.java",
      [
        "package com.acme.db;",
        "",
        "import jakarta.persistence.Entity;",
        "",
        "@Entity",
        "public class OrderEntity {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/client/RemoteClient.java",
      [
        "package com.acme.client;",
        "",
        "import java.net.http.HttpClient;",
        "",
        "public class RemoteClient {",
        "  private final HttpClient client = HttpClient.newHttpClient();",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/client/UriHolder.java",
      [
        "package com.acme.client;",
        "",
        "import java.net.URI;",
        "",
        "public class UriHolder {",
        "  private final URI endpoint;",
        "  public UriHolder(URI endpoint) { this.endpoint = endpoint; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/jobs/JobFactory.java",
      [
        "package com.acme.jobs;",
        "",
        "import org.scheduler.Job;",
        "",
        "public class JobFactory {",
        "  public Job buildJob() { return null; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/jobs/GenericJobFactory.java",
      [
        "package com.acme.jobs;",
        "",
        "import org.scheduler.Job;",
        "import org.scheduler.JobFactoryBase;",
        "",
        "public class GenericJobFactory<T> extends JobFactoryBase<T> {",
        "  public Job<T> buildJob() { return null; }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/PluginAdapter.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "public class PluginAdapter implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/RecordPlugin.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "public record RecordPlugin(String name) implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/ext/HelperFirstAdapter.java",
      [
        "package com.acme.ext;",
        "",
        "import org.plugins.Plugin;",
        "",
        "final class Helper {}",
        "public class HelperFirstAdapter implements Plugin {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/local/LocalCommandAdapter.java",
      [
        "package com.acme.local;",
        "",
        "import com.acme.local.Command;",
        "",
        "interface Command {}",
        "public class LocalCommandAdapter implements Command {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/google/myapp/GuavaAdapter.java",
      [
        "package com.google.myapp;",
        "",
        "import com.google.common.util.concurrent.Service;",
        "",
        "public class GuavaAdapter implements Service {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const bySource = new Map(result.features.map((feature) => [feature.source, feature]));

    expect(project.detected.packageManagers).toContain("gradle");
    expect(bySource.get("jvm-role-web-entrypoint")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/api/OrderController.java",
    );
    expect(bySource.get("jvm-role-application-service")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/app/BillingService.java",
    );
    expect(bySource.get("jvm-role-persistence-boundary")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/db/OrderEntity.java",
    );
    expect(bySource.get("jvm-role-external-client")?.ownedFiles[0]?.path).toBe(
      "src/main/java/com/acme/client/RemoteClient.java",
    );
    expect(
      bySource
        .get("jvm-role-framework-component")
        ?.ownedFiles.map((file) => file.path)
        .toSorted(),
    ).toEqual(
      [
        "src/main/java/com/google/myapp/GuavaAdapter.java",
        "src/main/java/com/acme/ext/HelperFirstAdapter.java",
        "src/main/java/com/acme/ext/PluginAdapter.java",
        "src/main/java/com/acme/ext/RecordPlugin.java",
        "src/main/java/com/acme/jobs/GenericJobFactory.java",
        "src/main/java/com/acme/jobs/JobFactory.java",
      ].toSorted(),
    );
    expect(
      bySource
        .get("jvm-role-extension-boundary")
        ?.ownedFiles.map((file) => file.path)
        .toSorted(),
    ).toEqual([
      "src/main/java/com/acme/ext/HelperFirstAdapter.java",
      "src/main/java/com/acme/ext/PluginAdapter.java",
      "src/main/java/com/acme/ext/RecordPlugin.java",
      "src/main/java/com/acme/local/LocalCommandAdapter.java",
      "src/main/java/com/google/myapp/GuavaAdapter.java",
    ]);
  });

  it("ignores vendored SwiftPM manifests during detection", async () => {
    const root = await fixtureRoot("clawpatch-vendored-swiftpm-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: MobileApp\n");
    await writeFixture(
      root,
      "apps/ios/SourcePackages/checkouts/Dependency/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Dependency")\n',
    );

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
  });

  it("detects Swift sources in pure Apple projects", async () => {
    const root = await fixtureRoot("clawpatch-pure-apple-swift-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: MobileApp\n");
    await writeFixture(root, "apps/ios/Sources/App.swift", "@main struct MobileApp {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
    expect(titles).toContain("Apple source apps/ios/Sources");
  });

  it("chooses Apple project manifests deterministically", async () => {
    const root = await fixtureRoot("clawpatch-apple-manifest-order-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/B.xcodeproj", "");
    await writeFixture(root, "apps/ios/A.xcworkspace", "");
    await writeFixture(root, "apps/ios/Sources/App.swift", "@main struct MobileApp {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apple = result.features.find((feature) => feature.title === "Apple project apps/ios");

    expect(apple?.entrypoints[0]?.path).toBe("apps/ios/A.xcworkspace");
  });

  it("maps Apple projects that also contain SwiftPM manifests", async () => {
    const root = await fixtureRoot("clawpatch-hybrid-apple-swiftpm-map-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(root, "apps/ios/project.yml", "name: HybridApp\n");
    await writeFixture(
      root,
      "apps/ios/Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "HybridApp", targets: [.target(name: "HybridApp")])
`,
    );
    await writeFixture(root, "apps/ios/Sources/HybridApp/App.swift", "public struct App {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("swiftpm");
    expect(titles).toContain("Apple project apps/ios");
    expect(titles).toContain("Apple source apps/ios/Sources");
    expect(titles).toContain("Swift target HybridApp (apps/ios)");
    expect(titles).not.toContain("Apple source apps/ios/Package.swift");
    expect(
      result.features
        .filter((feature) => feature.source === "apple-source-group")
        .flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("apps/ios/Package.swift");
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

  it("maps Go commands and internal packages", async () => {
    const root = await fixtureRoot("clawpatch-go-map-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(root, "cmd/tool/aaa.go", "package main\n\nfunc early() {}\n");
    await writeFixture(root, "cmd/tool/main.go", "package main\n\nfunc main() {}\n");
    await writeFixture(root, "cmd/tool/root.go", "package main\n\nfunc root() {}\n");
    await writeFixture(root, "internal/store/chats.go", "package store\n");
    await writeFixture(root, "internal/store/groups.go", "package store\n");
    await writeFixture(root, "internal/store/chats_test.go", "package store\n");
    await writeFixture(
      root,
      "internal/store/models.sql.go",
      "// Code generated by sqlc. DO NOT EDIT.\npackage store\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const command = result.features.find((feature) => feature.title === "Go command tool");
    const store = result.features.find((feature) => feature.title === "Go package store");

    expect(project.detected.languages).toContain("go");
    expect(project.detected.commands.test).toBe("go test ./...");
    expect(titles).toContain("Go command tool");
    expect(titles).toContain("Go package store");
    expect(command?.ownedFiles[0]?.path).toBe("cmd/tool/main.go");
    expect(command?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "cmd/tool/aaa.go",
      "cmd/tool/main.go",
      "cmd/tool/root.go",
    ]);
    expect(store?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "internal/store/chats.go",
      "internal/store/groups.go",
    ]);
    expect(store?.tests).toEqual([
      { path: "internal/store/chats_test.go", command: "go test ./..." },
    ]);
    expect(store?.contextFiles.map((file) => file.path)).toContain("internal/store/chats_test.go");
    expect(store?.contextFiles.map((file) => file.path)).toContain("internal/store/models.sql.go");
  });

  it("adds same-repo Go imports as context", async () => {
    const root = await fixtureRoot("clawpatch-go-import-context-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(
      root,
      "internal/app/app.go",
      'package app\n\nimport store "example.com/tool/internal/store"\n\nfunc Run() { store.Use() }\n',
    );
    await writeFixture(root, "internal/store/chats.go", "package store\n\nfunc Use() {}\n");
    await writeFixture(root, "internal/store/groups.go", "package store\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "Go package app");

    expect(app?.contextFiles.map((file) => file.path).toSorted()).toEqual([
      "internal/store/chats.go",
      "internal/store/groups.go",
    ]);
  });

  it("adds Go module root imports as context", async () => {
    const root = await fixtureRoot("clawpatch-go-root-import-context-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(root, "lib.go", "package tool\n\nfunc Run() {}\n");
    await writeFixture(
      root,
      "cmd/tool/main.go",
      'package main\n\nimport "example.com/tool"\n\nfunc main() { tool.Run() }\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const command = result.features.find((feature) => feature.title === "Go command tool");

    expect(command?.contextFiles.map((file) => file.path)).toContain("lib.go");
  });

  it("maps Go module root packages", async () => {
    const root = await fixtureRoot("clawpatch-go-root-package-");
    await writeFixture(root, "go.mod", "module example.com/rootpkg\n\ngo 1.26\n");
    await writeFixture(root, "main.go", "package main\n\nfunc main() {}\n");
    await writeFixture(root, "root.go", "package main\n\nfunc run() {}\n");
    await writeFixture(root, "root_test.go", "package main\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const command = result.features.find((feature) => feature.title === "Go command main");

    expect(command?.entrypoints[0]?.path).toBe("main.go");
    expect(command?.ownedFiles.map((file) => file.path).toSorted()).toEqual(["main.go", "root.go"]);
    expect(command?.tests).toEqual([{ path: "root_test.go", command: "go test ./..." }]);
  });

  it("maps Go packages from symlinked explicit roots", async () => {
    const root = await fixtureRoot("clawpatch-go-symlink-real-");
    const link = `${root}-link`;
    await writeFixture(root, "go.mod", "module example.com/symlink\n\ngo 1.26\n");
    await writeFixture(root, "cmd/tool/main.go", "package main\n\nfunc main() {}\n");
    await symlink(root, link, "dir");

    const project = await detectProject(link);
    const result = await mapFeatures(link, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Go command tool");
    expect(
      result.features.find((feature) => feature.title === "Go command tool")?.ownedFiles,
    ).toEqual([{ path: "cmd/tool/main.go", reason: "go package source" }]);
  });

  it("does not classify nested cmd packages as commands", async () => {
    const root = await fixtureRoot("clawpatch-go-nested-cmd-package-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(root, "cmd/tool/main.go", "package main\n\nfunc main() {}\n");
    await writeFixture(root, "cmd/tool/internal/store/store.go", "package store\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.filter((feature) => feature.title === "Go command tool")).toHaveLength(
      1,
    );
    expect(result.features.map((feature) => feature.title)).toContain("Go package store");
  });

  it("does not classify non-main cmd packages as commands", async () => {
    const root = await fixtureRoot("clawpatch-go-cmd-library-package-");
    await writeFixture(root, "go.mod", "module example.com/tool\n\ngo 1.26\n");
    await writeFixture(root, "cmd/tool/tool.go", "package tool\n\nfunc Helper() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Go package tool");
    expect(result.features.map((feature) => feature.title)).not.toContain("Go command tool");
    expect(result.features.find((feature) => feature.title === "Go package tool")?.kind).toBe(
      "library",
    );
  });

  it("uses partial Go list output before falling back", async () => {
    const root = await fixtureRoot("clawpatch-go-list-partial-");
    await writeFixture(root, "go.mod", "module example.com/broken\n\ngo 1.20\n");
    await writeFixture(root, "api/api.go", "package api\n\nfunc API() {}\n");
    await writeFixture(root, "mixed/a.go", "package a\n\nfunc A() {}\n");
    await writeFixture(root, "mixed/b.go", "package b\n\nfunc B() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Go package api");
    expect(result.features.map((feature) => feature.title)).toContain("Go package mixed");
  });

  it("reads root package names when Go list falls back", async () => {
    const root = await fixtureRoot("clawpatch-go-root-fallback-");
    await writeFixture(root, "go.mod", "module example.com/cache\n\ngo 999.0\n");
    await writeFixture(root, "cache.go", "package cache\n\nfunc Get() {}\n");
    await writeFixture(root, "api/api.go", "package api\n\nfunc API() {}\n");
    await writeFixture(root, "services/search/search.go", "package search\n\nfunc Search() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Go package cache");
    expect(result.features.map((feature) => feature.title)).toContain("Go package api");
    expect(result.features.map((feature) => feature.title)).toContain("Go package search");
    expect(result.features.map((feature) => feature.title)).not.toContain("Go command main");
  });

  it("parses large Go list output without truncating packages", async () => {
    const root = await fixtureRoot("clawpatch-go-list-large-");
    await writeFixture(root, "go.mod", "module example.com/large\n\ngo 1.26\n");
    for (let index = 0; index < 140; index += 1) {
      const name = `pkg${String(index).padStart(3, "0")}`;
      await writeFixture(root, `${name}/${name}.go`, `package ${name}\n`);
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Go package pkg000");
    expect(titles).toContain("Go package pkg070");
    expect(titles).toContain("Go package pkg139");
  });

  it("skips ignored Go package directories from Go list output", async () => {
    const root = await fixtureRoot("clawpatch-go-list-skip-");
    await writeFixture(root, "go.mod", "module example.com/skip\n\ngo 1.26\n");
    await writeFixture(root, "app/app.go", "package app\n");
    await writeFixture(root, "node_modules/dep/dep.go", "package dep\n");
    await writeFixture(root, "dist/gen/gen.go", "package gen\n");
    await writeFixture(root, "build/tmp/tmp.go", "package tmp\n");
    await writeFixture(root, "coverage/cov/cov.go", "package cov\n");
    await writeFixture(root, "target/cache/cache.go", "package cache\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Go package app");
    expect(titles).not.toContain("Go package dep");
    expect(titles).not.toContain("Go package gen");
    expect(titles).not.toContain("Go package tmp");
    expect(titles).not.toContain("Go package cov");
    expect(titles).not.toContain("Go package cache");
  });

  it("mirrors Go list exclusions during fallback discovery", async () => {
    const root = await fixtureRoot("clawpatch-go-fallback-skip-");
    await writeFixture(root, "go.mod", "module example.com/fallback\n\ngo 999.0\n");
    await writeFixture(root, "app/app.go", "package app\n");
    await writeFixture(root, "sub/go.mod", "module example.com/sub\n\ngo 1.20\n");
    await writeFixture(root, "sub/sub.go", "package sub\n");
    await writeFixture(root, "vendor/dep/dep.go", "package dep\n");
    await writeFixture(root, "testdata/fixture/fixture.go", "package fixture\n");
    await writeFixture(root, "_scratch/scratch.go", "package scratch\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Go package app");
    expect(titles).not.toContain("Go package sub");
    expect(titles).not.toContain("Go package dep");
    expect(titles).not.toContain("Go package fixture");
    expect(titles).not.toContain("Go package scratch");
  });

  it("maps Rust commands, libraries, integration tests, and Cargo defaults", async () => {
    const root = await fixtureRoot("clawpatch-rust-map-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rusty-tool"\n');
    await writeFixture(root, "src/main.rs", "fn main() {}\n");
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");
    await writeFixture(root, "src/bin/worker.rs", "fn main() {}\n");
    await writeFixture(root, "src/bin/admin/main.rs", "fn main() {}\n");
    await writeFixture(root, "crates/member/Cargo.toml", '[package]\nname = "member"\n');
    await writeFixture(root, "crates/member/src/lib.rs", "pub fn member() {}\n");
    await writeFixture(
      root,
      "crates/member/tests/member_integration.rs",
      "#[test]\nfn works() {}\n",
    );
    await writeFixture(root, "tests/integration.rs", "#[test]\nfn works() {}\n");
    await writeFixture(root, "tests/app.test.ts", "test('js', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("rust");
    expect(project.detected.packageManagers).toContain("cargo");
    expect(project.detected.commands.typecheck).toBe("cargo check --workspace --all-targets");
    expect(project.detected.commands.format).toBe("cargo fmt --all --check");
    expect(project.detected.commands.test).toBe("cargo test --workspace");
    expect(titles).toContain("Rust command admin");
    expect(titles).toContain("Rust command rusty-tool");
    expect(titles).toContain("Rust command worker");
    expect(titles).toContain("Rust library rusty-tool");
    expect(titles).toContain("Rust library member");
    expect(titles).toContain("Rust integration test integration");
    expect(titles).toContain("Rust integration test member/member_integration");
    expect(
      result.features.find((feature) => feature.title === "Rust library rusty-tool")?.tests,
    ).toEqual([{ path: "tests/integration.rs", command: "cargo test --workspace" }]);
    expect(
      result.features.find((feature) => feature.title === "Rust library member")?.tests,
    ).toEqual([
      {
        path: "crates/member/tests/member_integration.rs",
        command: "cargo test --manifest-path crates/member/Cargo.toml",
      },
    ]);
  });

  it("maps CMake C and C++ targets without duplicating main files", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-map-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      `add_executable(myapp src/main.cpp src/util.cpp)
add_executable(quoted "src/quoted.cpp")
ADD_EXECUTABLE(upper src/upper.c)
add_executable(absin ${root}/src/absin.cpp)
add_executable(absout /src/main.cpp)
add_executable(7zip src/seven.c)
add_executable(latebin)
target_sources(latebin PRIVATE src/late_main.c src/late_util.c)
#[[
add_executable(commented src/commented.c)
]]
add_library(core STATIC include/core.hpp src/core.c src/core_util.c)
add_library(foo.bar STATIC src/dot.c)
add_library(latelib)
target_sources(latelib PUBLIC src/late_lib.c include/late_lib.hpp)
ADD_LIBRARY(upperlib STATIC src/upperlib.c)
add_library(headers INTERFACE include/headers.hpp)
add_library(vendored INTERFACE vendor/dep.hpp)
add_executable(varapp \${APP_SOURCES})
add_executable(headerapp include/headers.hpp)
`,
    );
    await writeFixture(root, "src/main.cpp", "int main(int argc, char **argv) { return 0; }\n");
    await writeFixture(root, "src/quoted.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/upper.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/absin.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/seven.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/late_main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/late_util.c", "int late_util(void) { return 0; }\n");
    await writeFixture(root, "src/commented.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.cpp", "int util() { return 1; }\n");
    await writeFixture(root, "include/core.hpp", "int core(void);\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "src/core_util.c", "int core_util(void) { return 2; }\n");
    await writeFixture(root, "src/dot.c", "int dot(void) { return 1; }\n");
    await writeFixture(root, "src/late_lib.c", "int late_lib(void) { return 1; }\n");
    await writeFixture(root, "include/late_lib.hpp", "int late_lib(void);\n");
    await writeFixture(root, "src/upperlib.c", "int upperlib(void) { return 1; }\n");
    await writeFixture(root, "include/headers.hpp", "int header_only(void);\n");
    await writeFixture(root, "vendor/dep.hpp", "int dep(void);\n");
    await writeFixture(root, "tests/main_test.cpp", "int main() { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const myapp = result.features.find((feature) => feature.title === "CMake binary myapp");
    const latebin = result.features.find((feature) => feature.title === "CMake binary latebin");
    const core = result.features.find((feature) => feature.title === "CMake library core");
    const latelib = result.features.find((feature) => feature.title === "CMake library latelib");
    const headers = result.features.find((feature) => feature.title === "CMake library headers");
    const mainFeatures = result.features.filter(
      (feature) =>
        feature.kind === "cli-command" && feature.entrypoints[0]?.path === "src/main.cpp",
    );

    expect(project.detected.languages).toEqual(expect.arrayContaining(["c", "cpp"]));
    expect(project.detected.packageManagers).toContain("cmake");
    expect(titles).toContain("CMake binary myapp");
    expect(titles).toContain("CMake binary quoted");
    expect(titles).toContain("CMake binary upper");
    expect(titles).toContain("CMake binary absin");
    expect(titles).toContain("CMake binary 7zip");
    expect(titles).toContain("CMake binary latebin");
    expect(titles).not.toContain("CMake binary absout");
    expect(titles).not.toContain("CMake binary commented");
    expect(titles).toContain("CMake library core");
    expect(titles).toContain("CMake library foo.bar");
    expect(titles).toContain("CMake library latelib");
    expect(titles).toContain("CMake library upperlib");
    expect(titles).toContain("CMake library headers");
    expect(titles).not.toContain("CMake library vendored");
    expect(titles).not.toContain("CMake binary varapp");
    expect(titles).not.toContain("CMake binary headerapp");
    expect(titles).not.toContain("C++ binary main_test");
    expect(mainFeatures).toHaveLength(1);
    expect(myapp?.source).toBe("cmake-bin");
    expect(myapp?.ownedFiles).toEqual([
      { path: "src/main.cpp", reason: "target source" },
      { path: "src/util.cpp", reason: "target source" },
    ]);
    expect(myapp?.contextFiles).toEqual([
      { path: "CMakeLists.txt", reason: "CMake target declaration" },
      { path: "tests/main_test.cpp", reason: "nearby test" },
    ]);
    expect(myapp?.tests).toEqual([{ path: "tests/main_test.cpp", command: null }]);
    expect(latebin?.entrypoints[0]?.path).toBe("src/late_main.c");
    expect(latebin?.ownedFiles).toEqual([
      { path: "src/late_main.c", reason: "target source" },
      { path: "src/late_util.c", reason: "target source" },
    ]);
    expect(core?.entrypoints[0]?.path).toBe("src/core.c");
    expect(core?.entrypoints[0]?.symbol).toBeNull();
    expect(core?.ownedFiles).toEqual([
      { path: "include/core.hpp", reason: "target source" },
      { path: "src/core.c", reason: "target source" },
      { path: "src/core_util.c", reason: "target source" },
    ]);
    expect(latelib?.ownedFiles).toEqual([
      { path: "src/late_lib.c", reason: "target source" },
      { path: "include/late_lib.hpp", reason: "target source" },
    ]);
    expect(headers?.ownedFiles).toEqual([{ path: "include/headers.hpp", reason: "target source" }]);
  });

  it("does not attach unrelated top-level CMake tests to every target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-test-scope-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/app.cpp)\nadd_executable(tool src/tool.cpp)\n",
    );
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/tool.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/tool_test.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const tool = result.features.find((feature) => feature.title === "CMake binary tool");

    expect(app?.tests).toEqual([]);
    expect(tool?.tests).toEqual([{ path: "tests/tool_test.cpp", command: null }]);
  });

  it("maps CMake test executables as test suites", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-executable-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/app.cpp)\nadd_executable(unit_tests src/unit.cpp)\n",
    );
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/unit.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const suite = result.features.find(
      (feature) => feature.title === "CMake test suite unit_tests",
    );

    expect(titles).toContain("CMake binary app");
    expect(titles).not.toContain("CMake binary unit_tests");
    expect(titles).not.toContain("C++ binary unit");
    expect(suite).toMatchObject({
      kind: "test-suite",
      source: "cmake-test",
      entrypoints: [{ path: "src/unit.cpp", symbol: null, route: null, command: null }],
      ownedFiles: [{ path: "src/unit.cpp", reason: "target source" }],
    });
  });

  it("maps semicolon-separated CMake source lists", async () => {
    const root = await fixtureRoot("clawpatch-cmake-semicolon-sources-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/main.c;src/util.c)\nadd_library(core)\ntarget_sources(core PRIVATE src/core.c;include/core.h)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "include/core.h", "int core(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const core = result.features.find((feature) => feature.title === "CMake library core");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([
      { path: "src/core.c", reason: "target source" },
      { path: "include/core.h", reason: "target source" },
    ]);
  });

  it("keeps target_sources scoped to standalone CMake projects", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-sources-scope-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app)\ntarget_sources(app PRIVATE src/main.c)\n",
    );
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "add_executable(app)\ntarget_sources(app PRIVATE src/main.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apps = result.features.filter((feature) => feature.title === "CMake binary app");

    expect(apps.map((feature) => feature.entrypoints[0]?.path).toSorted()).toEqual([
      "src/main.c",
      "sub/src/main.c",
    ]);
    expect(
      apps.find((feature) => feature.entrypoints[0]?.path === "src/main.c")?.ownedFiles,
    ).toEqual([{ path: "src/main.c", reason: "target source" }]);
    expect(
      apps.find((feature) => feature.entrypoints[0]?.path === "sub/src/main.c")?.ownedFiles,
    ).toEqual([{ path: "sub/src/main.c", reason: "target source" }]);
  });

  it("attaches target_sources from CMake subdirectories", async () => {
    const root = await fixtureRoot("clawpatch-cmake-subdir-target-sources-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app)\nadd_subdirectory(src)\n");
    await writeFixture(root, "src/CMakeLists.txt", "target_sources(app PRIVATE main.c util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
    expect(titles).not.toContain("C binary main");
  });

  it("detects header-only C++ CMake libraries as C++ projects", async () => {
    const root = await fixtureRoot("clawpatch-cmake-header-only-cpp-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(headers INTERFACE include/headers.hpp)\n",
    );
    await writeFixture(root, "include/headers.hpp", "int header_only(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.languages).toContain("cpp");
    expect(result.features.map((feature) => feature.title)).toContain("CMake library headers");
  });

  it("maps uppercase C++ source extensions", async () => {
    const root = await fixtureRoot("clawpatch-cmake-uppercase-cpp-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(uppercpp src/MAIN.CPP src/HELPER.HPP)\n",
    );
    await writeFixture(root, "src/MAIN.CPP", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/HELPER.HPP", "int helper(void);\n");
    await writeFixture(root, "src/tool.C", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const uppercpp = result.features.find((feature) => feature.title === "CMake binary uppercpp");
    const tool = result.features.find((feature) => feature.title === "C++ binary tool");

    expect(project.detected.languages).toContain("cpp");
    expect(uppercpp?.entrypoints[0]).toMatchObject({ path: "src/MAIN.CPP", symbol: "main" });
    expect(uppercpp?.tags).toContain("cpp");
    expect(uppercpp?.ownedFiles).toEqual([
      { path: "src/MAIN.CPP", reason: "target source" },
      { path: "src/HELPER.HPP", reason: "target source" },
    ]);
    expect(tool?.entrypoints[0]).toMatchObject({ path: "src/tool.C", symbol: "main" });
    expect(tool?.tags).toContain("cpp");
  });

  it("preserves CMake targets that share the same source list", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-sources-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const coreStatic = result.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    const coreShared = result.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(titles).toContain("CMake library core_static");
    expect(titles).toContain("CMake library core_shared");
    expect(coreStatic?.entrypoints[0]?.symbol).toBe("core_static");
    expect(coreShared?.entrypoints[0]?.symbol).toBe("core_shared");
  });

  it("keeps existing CMake library ids when a target starts sharing sources", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-source-stability-");
    await writeFixture(root, "CMakeLists.txt", "add_library(core_static STATIC src/core.c)\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstCore = first.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_shared SHARED src/core.c)\nadd_library(core_static STATIC src/core.c)\n",
    );
    const second = await mapFeatures(root, project, first.features);
    const secondCore = second.features.find(
      (feature) => feature.title === "CMake library core_static",
    );
    const shared = second.features.find((feature) => feature.title === "CMake library core_shared");

    expect(secondCore?.featureId).toBe(firstCore?.featureId);
    expect(secondCore?.entrypoints[0]?.symbol).toBeNull();
    expect(shared?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(second.stale).toBe(0);
  });

  it("keeps disambiguated CMake library ids when source sharing stops", async () => {
    const root = await fixtureRoot("clawpatch-cmake-shared-source-removal-");
    await writeFixture(root, "CMakeLists.txt", "add_library(core_static STATIC src/core.c)\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    const second = await mapFeatures(root, project, first.features);
    const sharedDuringCollision = second.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );
    await writeFixture(root, "CMakeLists.txt", "add_library(core_shared SHARED src/core.c)\n");
    const third = await mapFeatures(root, project, second.features);
    const sharedAfterRemoval = third.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(sharedAfterRemoval?.featureId).toBe(sharedDuringCollision?.featureId);
    expect(sharedAfterRemoval?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(third.stale).toBe(1);
  });

  it("keeps initially disambiguated CMake library ids after source sharing stops", async () => {
    const root = await fixtureRoot("clawpatch-cmake-initial-shared-source-removal-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_library(core_static STATIC src/core.c)\nadd_library(core_shared SHARED src/core.c)\n",
    );
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const sharedDuringCollision = first.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );
    await writeFixture(root, "CMakeLists.txt", "add_library(core_shared SHARED src/core.c)\n");
    const second = await mapFeatures(root, project, first.features);
    const sharedAfterRemoval = second.features.find(
      (feature) => feature.title === "CMake library core_shared",
    );

    expect(sharedAfterRemoval?.featureId).toBe(sharedDuringCollision?.featureId);
    expect(sharedAfterRemoval?.entrypoints[0]?.symbol).toBe("core_shared");
    expect(second.stale).toBe(1);
  });

  it("does not map CMake target sources outside the project root", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-safe-sources-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(tool ../outside.c src/main.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const tool = result.features.find((feature) => feature.title === "CMake binary tool");

    expect(tool?.entrypoints[0]?.path).toBe("src/main.c");
    expect(tool?.ownedFiles).toEqual([{ path: "src/main.c", reason: "target source" }]);
    expect(
      result.features.flatMap((feature) => [
        ...feature.entrypoints.map((entrypoint) => entrypoint.path),
        ...feature.ownedFiles.map((file) => file.path),
      ]),
    ).not.toContain("../outside.c");
  });

  it("uses the CMake source that defines main as the executable entrypoint", async () => {
    const root = await fixtureRoot("clawpatch-cmake-cpp-main-entry-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/app.cpp src/main.cpp)\n");
    await writeFixture(root, "src/app.cpp", "struct App { int main(void) { return 0; } };\n");
    await writeFixture(root, "src/main.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const mainFeatures = result.features.filter(
      (feature) =>
        feature.kind === "cli-command" && feature.entrypoints[0]?.path === "src/main.cpp",
    );

    expect(app?.entrypoints[0]?.path).toBe("src/main.cpp");
    expect(mainFeatures).toHaveLength(1);
    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary main");
  });

  it("does not map member main methods as standalone C++ binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-member-main-");
    await writeFixture(root, "src/app.cpp", "struct App { int main(void) { return 0; } };\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary app");
  });

  it("resolves targets from included CMake modules relative to the source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-include-source-dir-");
    await writeFixture(root, "CMakeLists.txt", "include(cmake/Targets.cmake)\n");
    await writeFixture(root, "cmake/Targets.cmake", "add_executable(app src/main.c src/util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves nested CMake includes relative to the source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-include-source-dir-");
    await writeFixture(root, "CMakeLists.txt", "include(cmake/A.cmake)\n");
    await writeFixture(root, "cmake/A.cmake", "include(cmake/B.cmake)\n");
    await writeFixture(root, "cmake/B.cmake", "add_executable(app src/main.c src/util.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves repeated CMake includes relative to each source dir", async () => {
    const root = await fixtureRoot("clawpatch-cmake-repeated-include-source-dir-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app)\nadd_subdirectory(a)\nadd_subdirectory(b)\n",
    );
    await writeFixture(root, "a/CMakeLists.txt", "include(../cmake/Part.cmake)\n");
    await writeFixture(root, "b/CMakeLists.txt", "include(../cmake/Part.cmake)\n");
    await writeFixture(root, "cmake/Part.cmake", "target_sources(app PRIVATE local.c)\n");
    await writeFixture(root, "a/local.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "b/local.c", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("a/local.c");
    expect(app?.ownedFiles).toEqual([
      { path: "a/local.c", reason: "target source" },
      { path: "b/local.c", reason: "target source" },
    ]);
  });

  it("ignores unreferenced CMake modules", async () => {
    const root = await fixtureRoot("clawpatch-cmake-unreferenced-module-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c)\n");
    await writeFixture(root, "cmake/Dead.cmake", "add_executable(dead src/dead.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/dead.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("CMake binary app");
    expect(titles).not.toContain("CMake binary dead");
  });

  it("maps autotools C and C++ binary and library targets", async () => {
    const root = await fixtureRoot("clawpatch-autotools-cpp-map-");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = thing my-tool defaulted header-tool # installed helpers\nbin_PROGRAMS += appended\nthing_SOURCES = thing.c \\\n  util.c\nmy_tool_SOURCES = main.c tool-util.c\nappended_SOURCES = appended.c\nappended_SOURCES += appended_util.c\nheader_tool_SOURCES = include/header.hpp\nlib_LTLIBRARIES = libcore.la libcore-extra.la\nlib_LTLIBRARIES += libmore.la\nlibcore_la_SOURCES = core.cc core_util.cc\nlibcore_extra_la_SOURCES = extra.cc\nlibmore_la_SOURCES = more.c\nlibmore_la_SOURCES += more_util.c\n",
    );
    await writeFixture(root, "thing.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tool-util.c", "int tool_util(void) { return 1; }\n");
    await writeFixture(root, "appended.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "appended_util.c", "int appended_util(void) { return 1; }\n");
    await writeFixture(root, "defaulted.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cppdefault.cpp", "int main() { return 0; }\n");
    await writeFixture(root, "include/header.hpp", "int header(void);\n");
    await writeFixture(root, "core.cc", "int core() { return 1; }\n");
    await writeFixture(root, "core_util.cc", "int coreUtil() { return 2; }\n");
    await writeFixture(root, "extra.cc", "int extra() { return 3; }\n");
    await writeFixture(root, "more.c", "int more(void) { return 3; }\n");
    await writeFixture(root, "more_util.c", "int more_util(void) { return 4; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const thing = result.features.find((feature) => feature.title === "Autotools binary thing");
    const myTool = result.features.find((feature) => feature.title === "Autotools binary my-tool");
    const appended = result.features.find(
      (feature) => feature.title === "Autotools binary appended",
    );
    const defaulted = result.features.find(
      (feature) => feature.title === "Autotools binary defaulted",
    );
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");
    const extra = result.features.find(
      (feature) => feature.title === "Autotools library libcore-extra",
    );
    const more = result.features.find((feature) => feature.title === "Autotools library libmore");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.packageManagers).toContain("autotools");
    expect(titles).not.toContain("Autotools binary installed");
    expect(titles).not.toContain("Autotools binary helpers");
    expect(titles).not.toContain("Autotools binary header-tool");
    expect(titles).not.toContain("Autotools binary cppdefault");
    expect(titles).toContain("C++ binary cppdefault");
    expect(thing?.entrypoints[0]).toMatchObject({
      path: "thing.c",
      symbol: "main",
      command: "thing",
    });
    expect(myTool?.entrypoints[0]).toMatchObject({
      path: "main.c",
      symbol: "main",
      command: "my-tool",
    });
    expect(myTool?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "tool-util.c", reason: "target source" },
    ]);
    expect(appended?.ownedFiles).toEqual([
      { path: "appended.c", reason: "target source" },
      { path: "appended_util.c", reason: "target source" },
    ]);
    expect(defaulted?.entrypoints[0]).toMatchObject({
      path: "defaulted.c",
      symbol: "main",
      command: "defaulted",
    });
    expect(titles).not.toContain("C binary defaulted");
    expect(thing?.ownedFiles).toEqual([
      { path: "thing.c", reason: "target source" },
      { path: "util.c", reason: "target source" },
    ]);
    expect(core?.entrypoints[0]?.path).toBe("core.cc");
    expect(core?.ownedFiles).toEqual([
      { path: "core.cc", reason: "target source" },
      { path: "core_util.cc", reason: "target source" },
    ]);
    expect(extra?.ownedFiles).toEqual([{ path: "extra.cc", reason: "target source" }]);
    expect(more?.ownedFiles).toEqual([
      { path: "more.c", reason: "target source" },
      { path: "more_util.c", reason: "target source" },
    ]);
  });

  it("maps autotools targets from Makefile.in", async () => {
    const root = await fixtureRoot("clawpatch-autotools-makefile-in-");
    await writeFixture(
      root,
      "Makefile.in",
      "bin_PROGRAMS = app$(EXEEXT)\napp_SOURCES = main.c util.c\nlib_LTLIBRARIES = libcore.la\nlibcore_la_SOURCES = core.c\n",
    );
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "core.c", "int core(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "Autotools binary app");
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");

    expect(project.detected.packageManagers).toContain("autotools");
    expect(app?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([{ path: "core.c", reason: "target source" }]);
  });

  it("honors Automake assignment overrides", async () => {
    const root = await fixtureRoot("clawpatch-autotools-override-");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = old cleared\nbin_PROGRAMS = new\nold_SOURCES = old.c\nnew_SOURCES = stale.c\nnew_SOURCES = new.c\ncleared_SOURCES = cleared.c\ncleared_SOURCES =\n",
    );
    await writeFixture(root, "old.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "new.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "stale.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cleared.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const target = result.features.find((feature) => feature.title === "Autotools binary new");

    expect(titles).toContain("Autotools binary new");
    expect(titles).not.toContain("Autotools binary old");
    expect(titles).not.toContain("Autotools binary cleared");
    expect(target?.ownedFiles).toEqual([{ path: "new.c", reason: "target source" }]);
  });

  it("keeps same-named CMake and Autotools targets", async () => {
    const root = await fixtureRoot("clawpatch-cmake-autotools-same-target-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app main.c cmake_only.c)\n");
    await writeFixture(
      root,
      "Makefile.am",
      "bin_PROGRAMS = app\napp_SOURCES = main.c auto_only.c\n",
    );
    await writeFixture(root, "main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cmake_only.c", "int cmake_only(void) { return 0; }\n");
    await writeFixture(root, "auto_only.c", "int auto_only(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cmake = result.features.find((feature) => feature.title === "CMake binary app");
    const autotools = result.features.find((feature) => feature.title === "Autotools binary app");

    expect(cmake?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "cmake_only.c", reason: "target source" },
    ]);
    expect(autotools?.ownedFiles).toEqual([
      { path: "main.c", reason: "target source" },
      { path: "auto_only.c", reason: "target source" },
    ]);
  });

  it("maps standalone C main files without php-src extension semantics", async () => {
    const root = await fixtureRoot("clawpatch-c-main-map-");
    await writeFixture(root, "src/tool.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "ext/iconv/config.m4",
      "PHP_NEW_EXTENSION(iconv, iconv.c, $ext_shared)\n",
    );
    await writeFixture(root, "ext/iconv/iconv.c", "int iconv_helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const tool = result.features.find((feature) => feature.title === "C binary tool");

    expect(project.detected.languages).toContain("c");
    expect(tool?.entrypoints[0]).toMatchObject({
      path: "src/tool.c",
      symbol: "main",
      command: "tool",
    });
    expect(result.features.some((feature) => feature.source === "php-ext")).toBe(false);
    expect(
      result.features.some((feature) => feature.entrypoints[0]?.path === "ext/iconv/config.m4"),
    ).toBe(false);
  });

  it("skips C and C++ sample project paths", async () => {
    const root = await fixtureRoot("clawpatch-cpp-sample-paths-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(sample fixtures/example/main.c)\n");
    await writeFixture(root, "fixtures/example/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "testdata/CMakeLists.txt", "add_executable(sample main.c)\n");
    await writeFixture(root, "testdata/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some((feature) =>
        ["c-main", "cmake-bin", "cmake-lib", "autotools-bin", "autotools-lib"].includes(
          feature.source,
        ),
      ),
    ).toBe(false);
    expect(
      result.features.some((feature) => feature.entrypoints[0]?.path.includes("fixtures/")),
    ).toBe(false);
  });

  it("does not attach JavaScript tests to C and C++ entries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-js-test-");
    await writeFixture(root, "package.json", JSON.stringify({ scripts: { test: "vitest" } }));
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/app.test.ts", "test('app', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C++ binary app");

    expect(app?.tests).toEqual([]);
    expect(app?.contextFiles).toEqual([]);
  });

  it("attaches plural-suffixed C and C++ tests without mapping them as binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-plural-tests-");
    await writeFixture(root, "src/app.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/app_tests.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/FooTests.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/Contest.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/latest.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C++ binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(app?.tests).toEqual([{ path: "src/app_tests.cpp", command: null }]);
    expect(titles).not.toContain("C++ binary app_tests");
    expect(titles).not.toContain("C++ binary FooTests");
    expect(titles).toContain("C++ binary Contest");
    expect(titles).toContain("C++ binary latest");
  });

  it("attaches capitalized C and C++ test directories without mapping them as binaries", async () => {
    const root = await fixtureRoot("clawpatch-cpp-capitalized-tests-");
    await writeFixture(root, "src/parser.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "Tests/parser.cpp", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const parser = result.features.find((feature) => feature.title === "C++ binary parser");
    const titles = result.features.map((feature) => feature.title);

    expect(parser?.tests).toEqual([{ path: "Tests/parser.cpp", command: null }]);
    expect(titles.filter((title) => title === "C++ binary parser")).toHaveLength(1);
  });

  it("detects C and C++ main functions after literals containing braces", async () => {
    const root = await fixtureRoot("clawpatch-cpp-literal-braces-");
    await writeFixture(
      root,
      "src/app.cpp",
      'const char *json = "{\\"ok\\": true}";\nconst char *raw = R"tag({raw})tag";\nint main(void) { return 0; }\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("detects C and C++ main functions after literals containing comment markers", async () => {
    const root = await fixtureRoot("clawpatch-cpp-literal-comments-");
    await writeFixture(
      root,
      "src/app.cpp",
      'const char *url = R"json({"url":"http://example.com"})json";\nconst char *open = "/*";\nint main(void) { return 0; }\nconst char *close = "*/";\n',
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("ignores C and C++ block markers inside line comments", async () => {
    const root = await fixtureRoot("clawpatch-cpp-line-comment-block-marker-");
    await writeFixture(
      root,
      "src/app.cpp",
      "// /* disabled guard\nint main(void) { return 0; }\n// */\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("C++ binary app");
  });

  it("ignores comment-only C and C++ sources", async () => {
    const root = await fixtureRoot("clawpatch-cpp-comment-only-");
    await writeFixture(root, "src/placeholder.cpp", `// ${"x".repeat(200)}\n`);

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("C++ binary placeholder");
  });

  it("does not attach dependency C and C++ tests from skipped paths", async () => {
    const root = await fixtureRoot("clawpatch-cpp-skipped-nearby-tests-");
    await writeFixture(root, "app.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "vendor/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "CMakeFiles/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "cmake-build-debug/app_test.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "fixtures/app_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "C binary app");

    expect(app?.tests).toEqual([]);
    expect(app?.contextFiles).toEqual([]);
  });

  it("skips dependency trees during C and C++ discovery", async () => {
    const root = await fixtureRoot("clawpatch-cpp-dependency-paths-");
    await writeFixture(root, "src/app.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "vendor/tool/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, ".venv/native/main.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "CMakeFiles/CompilerIdCXX/CMakeCXXCompilerId.cpp",
      "int main(void) { return 0; }\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/generated/tool.cpp",
      "int main(void) { return 0; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(paths).toContain("src/app.c");
    expect(paths.some((path) => path.startsWith("vendor/"))).toBe(false);
    expect(paths.some((path) => path.startsWith(".venv/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("CMakeFiles/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("cmake-build-debug/"))).toBe(false);
  });

  it("ignores dependency and generated C and C++ files during detection", async () => {
    const root = await fixtureRoot("clawpatch-cpp-dependency-detect-");
    await writeFixture(root, "vendor/CMakeLists.txt", "add_executable(vendor main.c)\n");
    await writeFixture(root, "vendor/main.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "CMakeFiles/CompilerIdCXX/CMakeCXXCompilerId.cpp",
      "int main(void) { return 0; }\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/_deps/foo-src/CMakeLists.txt",
      "add_executable(foo main.cpp)\n",
    );
    await writeFixture(
      root,
      "cmake-build-debug/_deps/foo-src/main.cpp",
      "int main(void) { return 0; }\n",
    );

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("c");
    expect(project.detected.languages).not.toContain("cpp");
    expect(project.detected.packageManagers).not.toContain("cmake");
  });

  it("maps Python project metadata, console scripts, source groups, and tests", async () => {
    const root = await fixtureRoot("clawpatch-python-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project] # package metadata\nname = "py-tool"\ndependencies = ["pytest; python_version >= \'3.12\'", "ruff"]\n# "mypy"\n\n[project.scripts] # console scripts\npytool = "py_tool.cli:main"\n',
    );
    await writeFixture(root, "uv.lock", "");
    await writeFixture(root, "src/py_tool/__init__.py", "");
    await writeFixture(root, "src/py_tool/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "src/py_tool/store.py", "def get():\n    pass\n");
    await writeFixture(root, "src/py_tool/store_test.py", "def test_get():\n    pass\n");
    await writeFixture(root, "src/py_tool/generated_pb2.py", "generated = True\n");
    await writeFixture(root, ".venv/lib/site-packages/dep.py", "ignored = True\n");
    await writeFixture(root, "tests/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command pytool");
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.languages).toContain("python");
    expect(project.detected.packageManagers).toContain("uv");
    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(project.detected.commands.lint).toBe("uv run ruff check .");
    expect(project.detected.commands.format).toBe("uv run ruff format --check .");
    expect(titles).toContain("Python project py-tool");
    expect(titles).toContain("Python CLI command pytool");
    expect(titles).toContain("Python test suite tests");
    expect(cli?.entrypoints[0]?.path).toBe("src/py_tool/cli.py");
    expect(cli?.entrypoints[0]?.symbol).toBe("main");
    expect(cli?.tests).toEqual([
      { path: "src/py_tool/store_test.py", command: "uv run pytest" },
      { path: "tests/test_cli.py", command: "uv run pytest" },
    ]);
    expect(source?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/py_tool/__init__.py",
      "src/py_tool/cli.py",
      "src/py_tool/store.py",
    ]);
    expect(source?.ownedFiles.map((file) => file.path)).not.toContain(
      "src/py_tool/generated_pb2.py",
    );
  });

  it("resolves Python console scripts and tests from non-src package roots", async () => {
    const root = await fixtureRoot("clawpatch-python-roots-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "rooted"\ndependencies = ["pytest"]\n\n[project.scripts]\nrooted = "rooted.cli:main"\nlibbed = "libbed.cli:main"\n',
    );
    await writeFixture(root, "rooted/__init__.py", "");
    await writeFixture(root, "rooted/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "rooted/test_cli.py", "def test_cli():\n    pass\n");
    await writeFixture(root, "lib/libbed/__init__.py", "");
    await writeFixture(root, "lib/libbed/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "lib/libbed/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rooted = result.features.find((feature) => feature.title === "Python CLI command rooted");
    const libbed = result.features.find((feature) => feature.title === "Python CLI command libbed");

    expect(rooted?.entrypoints[0]?.path).toBe("rooted/cli.py");
    expect(rooted?.tests).toEqual([{ path: "rooted/test_cli.py", command: "pytest" }]);
    expect(libbed?.entrypoints[0]?.path).toBe("lib/libbed/cli.py");
    expect(libbed?.tests).toEqual([{ path: "lib/libbed/test_cli.py", command: "pytest" }]);
  });

  it("associates root-level pytest files with flat Python console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-flat-tests-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "flat"\ndependencies = ["pytest"]\n\n[project.scripts]\nflat = "cli:main"\n',
    );
    await writeFixture(root, "cli.py", "def main():\n    pass\n");
    await writeFixture(root, "test_cli.py", "def test_main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "Python CLI command flat");

    expect(cli?.entrypoints[0]?.path).toBe("cli.py");
    expect(cli?.tests).toEqual([{ path: "test_cli.py", command: "pytest" }]);
  });

  it("does not resolve Python console scripts through symlinked package dirs", async () => {
    const root = await fixtureRoot("clawpatch-python-script-symlink-root-");
    const external = await fixtureRoot("clawpatch-python-script-symlink-external-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "linked-script"\n\n[project.scripts]\nlinked = "pkg.cli:main"\n',
    );
    await writeFixture(external, "pkg/cli.py", "def main():\n    pass\n");
    await symlink(join(external, "pkg"), join(root, "pkg"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const cli = result.features.find((feature) => feature.title === "Python CLI command linked");

    expect(cli?.entrypoints[0]?.path).toBe("pyproject.toml");
    expect(cli?.ownedFiles).toEqual([
      { path: "pyproject.toml", reason: "console script metadata" },
    ]);
  });

  it("detects Python projects and conservative command defaults", async () => {
    const uvRoot = await fixtureRoot("clawpatch-python-uv-");
    await writeFixture(
      uvRoot,
      "pyproject.toml",
      '[project]\nname = "uv-app"\ndependencies = ["pytest", "pyright"]\n',
    );
    await writeFixture(uvRoot, "uv.lock", "");
    expect((await detectProject(uvRoot)).detected.commands).toMatchObject({
      typecheck: "uv run pyright",
      test: "uv run pytest",
    });

    const uvDevRoot = await fixtureRoot("clawpatch-python-uv-dev-");
    await writeFixture(
      uvDevRoot,
      "pyproject.toml",
      '[project]\nname = "uv-dev"\n\n[tool.uv]\ndev-dependencies = ["pytest", "ruff", "pyright"]\n',
    );
    await writeFixture(uvDevRoot, "uv.lock", "");
    expect((await detectProject(uvDevRoot)).detected.commands).toMatchObject({
      typecheck: "uv run pyright",
      lint: "uv run ruff check .",
      test: "uv run pytest",
    });

    const uvArrayRoot = await fixtureRoot("clawpatch-python-uv-array-table-");
    await writeFixture(
      uvArrayRoot,
      "pyproject.toml",
      '[project]\nname = "uv-array"\ndependencies = ["pytest"]\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    expect((await detectProject(uvArrayRoot)).detected).toMatchObject({
      packageManagers: ["uv"],
      commands: {
        test: "uv run pytest",
      },
    });

    const poetryRoot = await fixtureRoot("clawpatch-python-poetry-");
    await writeFixture(
      poetryRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-app"\n\n[tool.poetry.dependencies]\npython = "^3.12"\nmypy = "^1"\n\n[tool.poetry.group.test.dependencies]\npytest = "^8"\n\n[tool.poetry.group.lint.dependencies]\nruff = "^0.5"\n',
    );
    await writeFixture(poetryRoot, "poetry.lock", "");
    expect((await detectProject(poetryRoot)).detected.commands).toMatchObject({
      typecheck: "poetry run mypy .",
      lint: "poetry run ruff check .",
      test: "poetry run pytest",
    });

    const poetryPyprojectRoot = await fixtureRoot("clawpatch-python-poetry-pyproject-");
    await writeFixture(
      poetryPyprojectRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-pyproject"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\nruff = "^0.5"\n',
    );
    expect((await detectProject(poetryPyprojectRoot)).detected).toMatchObject({
      packageManagers: ["poetry"],
      commands: {
        lint: "poetry run ruff check .",
        test: "poetry run pytest",
      },
    });

    const hatchRoot = await fixtureRoot("clawpatch-python-hatch-");
    await writeFixture(
      hatchRoot,
      "pyproject.toml",
      '[project]\nname = "hatch-app"\ndependencies = ["pytest", "ruff"]\n',
    );
    await writeFixture(hatchRoot, "hatch.toml", "");
    expect((await detectProject(hatchRoot)).detected.commands).toMatchObject({
      lint: "hatch run ruff check .",
      test: "hatch run pytest",
    });

    const hatchPyprojectRoot = await fixtureRoot("clawpatch-python-hatch-pyproject-");
    await writeFixture(
      hatchPyprojectRoot,
      "pyproject.toml",
      '[project]\nname = "hatch-pyproject"\n\n[tool.hatch.envs.default]\ndependencies = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(hatchPyprojectRoot)).detected).toMatchObject({
      packageManagers: ["hatch"],
      commands: {
        lint: "hatch run ruff check .",
        test: "hatch run pytest",
      },
    });

    const setupCfgRoot = await fixtureRoot("clawpatch-python-setup-cfg-tools-");
    await writeFixture(
      setupCfgRoot,
      "setup.cfg",
      "[mypy]\nstrict = True\n\n[ruff]\nline-length = 100\n",
    );
    expect((await detectProject(setupCfgRoot)).detected.commands).toMatchObject({
      typecheck: "mypy .",
      lint: "ruff check .",
      format: "ruff format --check .",
    });

    const setupCfgExtrasNameRoot = await fixtureRoot("clawpatch-python-setup-cfg-extras-name-");
    await writeFixture(
      setupCfgExtrasNameRoot,
      "setup.cfg",
      "[metadata]\nname = extras-name\n\n[options.extras_require]\npytest =\n    httpx\nruff =\n    typing-extensions\n",
    );
    expect((await detectProject(setupCfgExtrasNameRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const setupCfgCommentRoot = await fixtureRoot("clawpatch-python-setup-cfg-pytest-comment-");
    await writeFixture(
      setupCfgCommentRoot,
      "setup.cfg",
      "[metadata]\nname = comment-only\n# [pytest]\ndescription = mentions [pytest]\n",
    );
    expect((await detectProject(setupCfgCommentRoot)).detected.commands.test).toBeNull();

    const setupCfgExtrasValueRoot = await fixtureRoot("clawpatch-python-setup-cfg-extras-value-");
    await writeFixture(
      setupCfgExtrasValueRoot,
      "setup.cfg",
      "[metadata]\nname = extras-value\n\n[options.extras_require]\ndev =\n    pytest\n    ruff\n",
    );
    expect((await detectProject(setupCfgExtrasValueRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      test: "pytest",
    });

    const markerRoot = await fixtureRoot("clawpatch-python-marker-deps-");
    await writeFixture(
      markerRoot,
      "pyproject.toml",
      '[project]\nname = "markers"\ndependencies = ["ruff; python_version < \'3.13\'", "pytest"]\n# "mypy"\n',
    );
    expect((await detectProject(markerRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      test: "pytest",
    });

    const pdmRoot = await fixtureRoot("clawpatch-python-pdm-");
    await writeFixture(pdmRoot, "requirements.txt", "pytest\nruff\n");
    await writeFixture(pdmRoot, "pdm.lock", "");
    expect((await detectProject(pdmRoot)).detected.commands).toMatchObject({
      typecheck: "pdm run ruff check .",
      lint: "pdm run ruff check .",
      test: "pdm run pytest",
    });

    const pdmPyprojectRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-");
    await writeFixture(
      pdmPyprojectRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest", "ruff", "pyright"]\n',
    );
    await writeFixture(pdmPyprojectRoot, "pdm.lock", "");
    expect((await detectProject(pdmPyprojectRoot)).detected.commands).toMatchObject({
      typecheck: "pdm run pyright",
      lint: "pdm run ruff check .",
      test: "pdm run pytest",
    });

    const pdmPyprojectNoLockRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-no-lock-");
    await writeFixture(
      pdmPyprojectNoLockRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(pdmPyprojectNoLockRoot)).detected).toMatchObject({
      packageManagers: ["pdm"],
      commands: {
        lint: "pdm run ruff check .",
        test: "pdm run pytest",
      },
    });

    const directRoot = await fixtureRoot("clawpatch-python-direct-");
    await writeFixture(directRoot, "setup.py", "from setuptools import setup\n");
    await writeFixture(directRoot, "tests/test_app.py", "def test_app():\n    pass\n");
    expect((await detectProject(directRoot)).detected.commands.test).toBe("pytest");

    const nullRoot = await fixtureRoot("clawpatch-python-null-");
    await writeFixture(nullRoot, "src/app/main.py", "def main():\n    pass\n");
    const nullProject = await detectProject(nullRoot);
    expect(nullProject.detected.languages).toContain("python");
    expect(nullProject.detected.packageManagers).toContain("python");
    expect(nullProject.detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const groupNameRoot = await fixtureRoot("clawpatch-python-group-names-");
    await writeFixture(
      groupNameRoot,
      "pyproject.toml",
      '[project]\nname = "groups"\n\n[project.optional-dependencies]\npytest = ["httpx"]\nruff = ["typing-extensions"]\n',
    );
    expect((await detectProject(groupNameRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const commentedGroupRoot = await fixtureRoot("clawpatch-python-commented-groups-");
    await writeFixture(
      commentedGroupRoot,
      "pyproject.toml",
      '[project]\nname = "commented-groups"\n\n[dependency-groups]\n#dev = ["pytest", "ruff"]\n',
    );
    expect((await detectProject(commentedGroupRoot)).detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });

    const dependencyGroupRoot = await fixtureRoot("clawpatch-python-dependency-groups-");
    await writeFixture(
      dependencyGroupRoot,
      "pyproject.toml",
      '[project]\nname = "dependency-groups"\n\n[dependency-groups]\ndev = [\n  "pytest",\n  "ruff",\n]\n',
    );
    expect((await detectProject(dependencyGroupRoot)).detected.commands).toMatchObject({
      lint: "ruff check .",
      format: "ruff format --check .",
      test: "pytest",
    });
  });

  it("maps root-level Python pytest files", async () => {
    const root = await fixtureRoot("clawpatch-python-root-tests-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "root-tests"\n');
    await writeFixture(root, "test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suite = result.features.find((feature) => feature.title === "Python test suite tests");

    expect(project.detected.commands.test).toBe("pytest");
    expect(suite?.ownedFiles).toEqual([{ path: "test_app.py", reason: "pytest file" }]);
    expect(suite?.tests).toEqual([{ path: "test_app.py", command: "pytest" }]);
  });

  it("maps Flask routes under web source roots", async () => {
    const root = await fixtureRoot("clawpatch-python-flask-routes-");
    await writeFixture(root, "requirements.txt", "Flask\npytest\n");
    await writeFixture(
      root,
      "web/app.py",
      [
        "from flask import Flask",
        "",
        "app = Flask(__name__)",
        "",
        "@app.route('/')",
        "def index():",
        "    return 'ok'",
        "",
        "@app.route('/api/items', methods=['GET', 'POST'])",
        "def items():",
        "    return 'items'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "web/blueprints/admin.py",
      [
        "from flask import Blueprint",
        "",
        "admin_bp = Blueprint('admin', __name__)",
        "",
        "@admin_bp.route(",
        "    '/admin/run-once',",
        "    methods=['POST'],",
        ")",
        "def run_once():",
        "    return 'queued'",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "web/test_app.py", "def test_index():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const index = result.features.find((feature) => feature.title === "Flask route GET /");
    const items = result.features.find(
      (feature) => feature.title === "Flask route GET,POST /api/items",
    );
    const admin = result.features.find(
      (feature) => feature.title === "Flask route POST /admin/run-once",
    );

    expect(project.detected.frameworks).toContain("flask");
    expect(titles).toContain("Python source web");
    expect(index?.source).toBe("python-flask-route");
    expect(index?.entrypoints[0]).toMatchObject({
      path: "web/app.py",
      symbol: "index",
      route: "GET /",
    });
    expect(index?.tests).toEqual([{ path: "web/test_app.py", command: "pytest" }]);
    expect(items?.entrypoints[0]?.route).toBe("GET,POST /api/items");
    expect(admin?.trustBoundaries).toContain("auth");
  });

  it("maps root-level Flask entry files and non-list methods", async () => {
    const root = await fixtureRoot("clawpatch-python-flask-root-routes-");
    await writeFixture(root, "requirements.txt", "Flask\npytest\n");
    await writeFixture(
      root,
      "app.py",
      [
        "from flask import Flask",
        "",
        "app = Flask(__name__)",
        "DYNAMIC_METHODS = ['POST']",
        "",
        "@app.route('/')",
        "def index():",
        "    return 'ok'",
        "",
        "@app.route('/submit', methods=('POST',))",
        "def submit():",
        "    return 'submitted'",
        "",
        "@app.route('/token', methods={'POST', 'DELETE'})",
        "def token():",
        "    return 'token'",
        "",
        "@app.route('/dynamic', methods=DYNAMIC_METHODS)",
        "def dynamic():",
        "    return 'dynamic'",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "test_app.py", "def test_index():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const routes = result.features.filter((feature) => feature.source === "python-flask-route");
    const byTitle = (title: string) => routes.find((feature) => feature.title === title);

    expect(project.detected.frameworks).toContain("flask");
    expect(byTitle("Flask route GET /")?.entrypoints[0]).toMatchObject({
      path: "app.py",
      symbol: "index",
      route: "GET /",
    });
    expect(byTitle("Flask route POST /submit")?.tests).toEqual([
      { path: "test_app.py", command: "pytest" },
    ]);
    expect(byTitle("Flask route POST,DELETE /token")?.trustBoundaries).toContain("auth");
    expect(routes.map((feature) => feature.title)).not.toContain("Flask route GET /dynamic");
  });

  it("does not map generic Python route decorators as Flask routes", async () => {
    const root = await fixtureRoot("clawpatch-python-generic-routes-");
    await writeFixture(root, "requirements.txt", "pytest\n");
    await writeFixture(
      root,
      "web/app.py",
      [
        "class Router:",
        "    def route(self, path):",
        "        def wrapper(fn):",
        "            return fn",
        "        return wrapper",
        "",
        "router = Router()",
        "",
        "@router.route('/not-flask')",
        "def handler():",
        "    return 'ok'",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.frameworks).not.toContain("flask");
    expect(result.features.some((feature) => feature.source === "python-flask-route")).toBe(false);
  });

  it("maps FastAPI routes in root and web source files", async () => {
    const root = await fixtureRoot("clawpatch-python-fastapi-routes-");
    await writeFixture(root, "requirements.txt", "fastapi\npytest\n");
    await writeFixture(
      root,
      "app.py",
      [
        "from fastapi import FastAPI",
        "",
        "app = FastAPI()",
        "",
        "@app.get('/health')",
        "async def health():",
        "    return {'ok': True}",
        "",
        "@app.api_route('/webhook/{token}', methods=['GET', 'HEAD'])",
        "def webhook(token: str):",
        "    return token",
        "",
        "@app.api_route('/submit', methods=('POST',))",
        "def submit():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "web/api.py",
      [
        "from fastapi import APIRouter",
        "",
        "router = APIRouter()",
        "",
        "@router.post(",
        "    path='/admin/jobs',",
        ")",
        "def create_job():",
        "    return {'queued': True}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "tests/test_app.py", "def test_health():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const health = result.features.find((feature) => feature.title === "FastAPI route GET /health");
    const webhook = result.features.find(
      (feature) => feature.title === "FastAPI route GET,HEAD /webhook/{token}",
    );
    const submit = result.features.find(
      (feature) => feature.title === "FastAPI route POST /submit",
    );
    const admin = result.features.find(
      (feature) => feature.title === "FastAPI route POST /admin/jobs",
    );

    expect(project.detected.frameworks).toContain("fastapi");
    expect(health?.source).toBe("python-fastapi-route");
    expect(health?.entrypoints[0]).toMatchObject({
      path: "app.py",
      symbol: "health",
      route: "GET /health",
    });
    expect(health?.tests).toEqual([{ path: "tests/test_app.py", command: "pytest" }]);
    expect(webhook?.entrypoints[0]?.route).toBe("GET,HEAD /webhook/{token}");
    expect(submit?.entrypoints[0]?.route).toBe("POST /submit");
    expect(admin?.entrypoints[0]).toMatchObject({
      path: "web/api.py",
      symbol: "create_job",
      route: "POST /admin/jobs",
    });
    expect(admin?.trustBoundaries).toContain("auth");
  });

  it("detects metadata-free root and web Python sources", async () => {
    const root = await fixtureRoot("clawpatch-python-root-web-detect-");
    await writeFixture(root, "app.py", "def app():\n    pass\n");
    await writeFixture(
      root,
      "web/api.py",
      [
        "from fastapi import APIRouter",
        "",
        "router = APIRouter()",
        "",
        "@router.get(path='/health')",
        "def health():",
        "    return {'ok': True}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const rootSource = result.features.find((feature) => feature.title === "Python source root");
    const webRoute = result.features.find(
      (feature) => feature.title === "FastAPI route GET /health",
    );

    expect(project.detected.languages).toContain("python");
    expect(project.detected.packageManagers).toContain("python");
    expect(project.detected.frameworks).toContain("fastapi");
    expect(rootSource?.ownedFiles).toEqual([{ path: "app.py", reason: "source group root" }]);
    expect(webRoute?.entrypoints[0]).toMatchObject({
      path: "web/api.py",
      symbol: "health",
      route: "GET /health",
    });
  });

  it("uses Hatch pytest commands in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-hatch-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "hatch-map"\n\n[tool.hatch.envs.default]\ndependencies = ["pytest"]\n',
    );
    await writeFixture(root, "src/hatch_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/hatch_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("hatch run pytest");
    expect(source?.tests).toEqual([
      { path: "src/hatch_map/test_app.py", command: "hatch run pytest" },
    ]);
  });

  it("uses uv pytest commands from pyproject uv config in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-pyproject-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "uv-map"\n\n[tool.uv]\ndev-dependencies = ["pytest"]\n',
    );
    await writeFixture(root, "src/uv_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/uv_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(source?.tests).toEqual([{ path: "src/uv_map/test_app.py", command: "uv run pytest" }]);
  });

  it("uses uv pytest commands from pyproject uv array-table config in mapped Python features", async () => {
    const root = await fixtureRoot("clawpatch-python-uv-array-map-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "uv-array-map"\ndependencies = ["pytest"]\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    await writeFixture(root, "src/uv_array_map/app.py", "def app():\n    pass\n");
    await writeFixture(root, "src/uv_array_map/test_app.py", "def test_app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.commands.test).toBe("uv run pytest");
    expect(source?.tests).toEqual([
      { path: "src/uv_array_map/test_app.py", command: "uv run pytest" },
    ]);
  });

  it("uses Poetry and PDM pytest commands from pyproject tool config in mapped Python features", async () => {
    const poetryRoot = await fixtureRoot("clawpatch-python-poetry-pyproject-map-");
    await writeFixture(
      poetryRoot,
      "pyproject.toml",
      '[tool.poetry]\nname = "poetry-map"\n\n[tool.poetry.group.dev.dependencies]\npytest = "^8"\n',
    );
    await writeFixture(poetryRoot, "src/poetry_map/app.py", "def app():\n    pass\n");
    await writeFixture(poetryRoot, "src/poetry_map/test_app.py", "def test_app():\n    pass\n");

    const poetryProject = await detectProject(poetryRoot);
    const poetryResult = await mapFeatures(poetryRoot, poetryProject, []);
    const poetrySource = poetryResult.features.find(
      (feature) => feature.title === "Python source src",
    );
    expect(poetrySource?.tests).toEqual([
      { path: "src/poetry_map/test_app.py", command: "poetry run pytest" },
    ]);

    const pdmRoot = await fixtureRoot("clawpatch-python-pdm-pyproject-map-");
    await writeFixture(
      pdmRoot,
      "pyproject.toml",
      '[tool.pdm.dev-dependencies]\ndev = ["pytest"]\n',
    );
    await writeFixture(pdmRoot, "src/pdm_map/app.py", "def app():\n    pass\n");
    await writeFixture(pdmRoot, "src/pdm_map/test_app.py", "def test_app():\n    pass\n");

    const pdmProject = await detectProject(pdmRoot);
    const pdmResult = await mapFeatures(pdmRoot, pdmProject, []);
    const pdmSource = pdmResult.features.find((feature) => feature.title === "Python source src");
    expect(pdmSource?.tests).toEqual([
      { path: "src/pdm_map/test_app.py", command: "pdm run pytest" },
    ]);
  });

  it("maps Python metadata-only projects without pyproject", async () => {
    const root = await fixtureRoot("clawpatch-python-legacy-metadata-");
    await writeFixture(root, "setup.cfg", "[metadata]\nname = legacy\n");
    await writeFixture(root, "requirements.txt", "pytest\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const metadata = result.features.find((feature) => feature.source === "python-project");

    expect(project.detected.languages).toContain("python");
    expect(metadata?.entrypoints[0]?.path).toBe("setup.cfg");
    expect(metadata?.ownedFiles).toEqual([
      { path: "setup.cfg", reason: "python project metadata" },
      { path: "requirements.txt", reason: "python project metadata" },
    ]);
  });

  it("keeps Python source group ids stable when a root gains files", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-source-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-source"\n');
    await writeFixture(root, "scripts/tool.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSource = first.features.find((feature) => feature.title === "Python source scripts");
    await writeFixture(root, "scripts/other.py", "def other():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSource = second.features.find(
      (feature) => feature.title === "Python source scripts",
    );

    expect(firstSource?.featureId).toBeDefined();
    expect(secondSource?.featureId).toBe(firstSource?.featureId);
    expect(second.stale).toBe(0);
  });

  it("keeps Python pytest suite ids stable when tests are added", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-test-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-tests"\n');
    await writeFixture(root, "tests/test_b.py", "def test_b():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSuite = first.features.find(
      (feature) => feature.title === "Python test suite tests",
    );
    await writeFixture(root, "tests/test_a.py", "def test_a():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSuite = second.features.find(
      (feature) => feature.title === "Python test suite tests",
    );

    expect(firstSuite?.featureId).toBeDefined();
    expect(secondSuite?.featureId).toBe(firstSuite?.featureId);
    expect(second.stale).toBe(0);
  });

  it("keeps root-level Python pytest suite ids stable when tests are added", async () => {
    const root = await fixtureRoot("clawpatch-python-stable-root-test-id-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "stable-root-tests"\n');
    await writeFixture(root, "test_b.py", "def test_b():\n    pass\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstSuite = first.features.find(
      (feature) => feature.title === "Python test suite tests",
    );
    await writeFixture(root, "test_a.py", "def test_a():\n    pass\n");
    const second = await mapFeatures(root, project, first.features);
    const secondSuite = second.features.find(
      (feature) => feature.title === "Python test suite tests",
    );

    expect(firstSuite?.featureId).toBeDefined();
    expect(secondSuite?.featureId).toBe(firstSuite?.featureId);
    expect(second.stale).toBe(0);
  });

  it("stops Python script parsing at TOML array-table headers", async () => {
    const root = await fixtureRoot("clawpatch-python-array-table-script-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "array-table"\n\n[project.scripts]\nreal = "pkg.cli:main"\n\n[[tool.uv.index]]\nname = "private"\nurl = "https://example.invalid/simple"\n',
    );
    await writeFixture(root, "pkg/__init__.py", "");
    await writeFixture(root, "pkg/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const commands = result.features
      .filter((feature) => feature.source === "python-console-script")
      .map((feature) => feature.entrypoints[0]?.command);

    expect(commands).toEqual(["real"]);
  });

  it("does not map commented Python console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-commented-script-");
    await writeFixture(
      root,
      "pyproject.toml",
      '[project]\nname = "commented-script"\n\n[project.scripts]\n#old = "pkg.old:main"\nreal = "pkg.cli:main"\n',
    );
    await writeFixture(root, "pkg/__init__.py", "");
    await writeFixture(root, "pkg/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const commands = result.features
      .filter((feature) => feature.source === "python-console-script")
      .map((feature) => feature.entrypoints[0]?.command);

    expect(commands).toEqual(["real"]);
  });

  it("groups colocated Python pytest suites by their actual directory", async () => {
    const root = await fixtureRoot("clawpatch-python-colocated-test-groups-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "colocated-tests"\n');
    for (let index = 0; index < 13; index += 1) {
      await writeFixture(root, `src/pkg/test_${index}.py`, `def test_${index}():\n    pass\n`);
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suites = result.features.filter((feature) => feature.source === "python-test-suite");

    expect(suites.map((feature) => feature.title)).toEqual([
      "Python test suite src/pkg#1",
      "Python test suite src/pkg#2",
    ]);
    expect(
      suites
        .flatMap((feature) => feature.ownedFiles)
        .every((file) => file.path.startsWith("src/pkg/")),
    ).toBe(true);
  });

  it("groups nested Python star-test files by their actual directory", async () => {
    const root = await fixtureRoot("clawpatch-python-nested-star-test-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "nested-star-tests"\n');
    await writeFixture(root, "src/pkg/store_test.py", "def test_store():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const suite = result.features.find((feature) => feature.source === "python-test-suite");

    expect(suite?.title).toBe("Python test suite src/pkg");
    expect(suite?.entrypoints[0]?.path).toBe("src/pkg");
    expect(suite?.ownedFiles).toEqual([{ path: "src/pkg/store_test.py", reason: "pytest file" }]);
  });

  it("does not map Python test support modules as pytest suites", async () => {
    const root = await fixtureRoot("clawpatch-python-test-support-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "support-only"\n');
    await writeFixture(root, "tests/helpers.py", "def helper():\n    pass\n");
    await writeFixture(root, "tests/conftest.py", "def pytest_configure():\n    pass\n");
    await writeFixture(root, "tests/__init__.py", "");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.some((feature) => feature.source === "python-test-suite")).toBe(false);
  });

  it("does not map Python fixture sample tests as pytest suites", async () => {
    const root = await fixtureRoot("clawpatch-python-fixture-tests-");
    await writeFixture(root, "pyproject.toml", '[project]\nname = "fixture-only"\n');
    await writeFixture(root, "tests/fixtures/test_sample.py", "def test_sample():\n    pass\n");
    await writeFixture(root, "tests/__fixtures__/test_sample.py", "def test_sample():\n    pass\n");
    await writeFixture(root, "testdata/test_sample.py", "def test_sample():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.some((feature) => feature.source === "python-test-suite")).toBe(false);
  });

  it("maps Python source-only projects without a full source-group pre-scan", async () => {
    const root = await fixtureRoot("clawpatch-python-source-only-");
    await writeFixture(root, "src/source_only/app.py", "def app():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Python source src");

    expect(project.detected.languages).toContain("python");
    expect(source?.ownedFiles).toEqual([
      { path: "src/source_only/app.py", reason: "source group src" },
    ]);
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

  it("maps Cargo workspace members outside crates", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-");
    await writeFixture(root, "Cargo.toml", "[workspace]\nmembers = ['cli', 'core']\n");
    await writeFixture(root, "cli/Cargo.toml", '[package]\nname = "workspace-cli"\n');
    await writeFixture(root, "cli/src/main.rs", "fn main() {}\n");
    await writeFixture(root, "core/Cargo.toml", '[package]\nname = "workspace-core"\n');
    await writeFixture(root, "core/src/lib.rs", "pub fn run() {}\n");
    await writeFixture(root, "core/tests/core_integration.rs", "#[test]\nfn works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust command workspace-cli");
    expect(titles).toContain("Rust library workspace-core");
    expect(titles).toContain("Rust integration test workspace-core/core_integration");
    expect(
      result.features.find((feature) => feature.title === "Rust library workspace-core")?.tests,
    ).toEqual([{ path: "core/tests/core_integration.rs", command: "cargo test --workspace" }]);
  });

  it("does not map virtual Cargo workspace root sources", async () => {
    const root = await fixtureRoot("clawpatch-rust-virtual-workspace-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["core"]\n');
    await writeFixture(root, "src/lib.rs", "pub fn ignored() {}\n");
    await writeFixture(root, "src/main.rs", "fn main() {}\n");
    await writeFixture(root, "tests/root.rs", "#[test]\nfn ignored() {}\n");
    await writeFixture(root, "core/Cargo.toml", '[package]\nname = "core"\n');
    await writeFixture(root, "core/src/lib.rs", "pub fn core() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library core");
    expect(titles).not.toContain("Rust library crate");
    expect(titles).not.toContain("Rust command crate");
    expect(titles).not.toContain("Rust integration test root");
  });

  it("reads Cargo package names from the package section", async () => {
    const root = await fixtureRoot("clawpatch-rust-package-name-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[workspace.metadata]
name = "workspace-name"

[package]
name = 'actual-pkg'
`,
    );
    await writeFixture(root, "src/main.rs", "fn main() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust command actual-pkg");
    expect(titles).not.toContain("Rust command workspace-name");
  });

  it("ignores commented and excluded Cargo workspace members", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-comments-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[workspace]
members = [
  # "old",
  "./crates/*/"
]
exclude = ["./crates/old/"]
`,
    );
    await writeFixture(root, "old/Cargo.toml", '[package]\nname = "old"\n');
    await writeFixture(root, "old/src/lib.rs", "pub fn old() {}\n");
    await writeFixture(root, "crates/old/Cargo.toml", '[package]\nname = "old-crate"\n');
    await writeFixture(root, "crates/old/src/lib.rs", "pub fn old_crate() {}\n");
    await writeFixture(root, "crates/core/Cargo.toml", '[package]\nname = "core"\n');
    await writeFixture(root, "crates/core/src/lib.rs", "pub fn core() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library core");
    expect(titles.filter((title) => title === "Rust library core")).toHaveLength(1);
    expect(titles).not.toContain("Rust library old");
    expect(titles).not.toContain("Rust library old-crate");
  });

  it("expands Cargo workspace member glob segments", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-glob-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["crates/o*"]\n');
    await writeFixture(root, "crates/old-one/Cargo.toml", '[package]\nname = "old-one"\n');
    await writeFixture(root, "crates/old-one/src/lib.rs", "pub fn old() {}\n");
    await writeFixture(root, "crates/new-one/Cargo.toml", '[package]\nname = "new-one"\n');
    await writeFixture(root, "crates/new-one/src/lib.rs", "pub fn new() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library old-one");
    expect(titles).not.toContain("Rust library new-one");
  });

  it("does not map Cargo workspace members without package manifests", async () => {
    const root = await fixtureRoot("clawpatch-rust-member-manifest-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
    await writeFixture(root, "crates/template/src/lib.rs", "pub fn template() {}\n");
    await writeFixture(root, "crates/real/Cargo.toml", '[package]\nname = "real"\n');
    await writeFixture(root, "crates/real/src/lib.rs", "pub fn real() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library real");
    expect(titles).not.toContain("Rust library template");
  });

  it("ignores Cargo members outside the workspace section", async () => {
    const root = await fixtureRoot("clawpatch-rust-metadata-members-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[package]
name = "root"

[package.metadata.foo]
members = ["tools/old"]
`,
    );
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(root, "tools/old/Cargo.toml", '[package]\nname = "old"\n');
    await writeFixture(root, "tools/old/src/lib.rs", "pub fn old() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library root");
    expect(titles).not.toContain("Rust library old");
  });

  it("skips duplicate and symlinked Cargo workspace members", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-safe-");
    const external = await fixtureRoot("clawpatch-rust-workspace-external-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[package]\nname = "rootpkg"\n\n[workspace]\nmembers = [".", "linked/member"]\n',
    );
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(external, "member/Cargo.toml", '[package]\nname = "outside"\n');
    await writeFixture(external, "member/src/lib.rs", "pub fn outside() {}\n");
    await symlink(external, join(root, "linked"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles.filter((title) => title === "Rust library rootpkg")).toHaveLength(1);
    expect(titles).not.toContain("Rust library outside");
    expect(paths).not.toContain("./src/lib.rs");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  it("does not scan symlinked conventional crates directories", async () => {
    const root = await fixtureRoot("clawpatch-rust-crates-symlink-root-");
    const external = await fixtureRoot("clawpatch-rust-crates-symlink-external-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rootpkg"\n');
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(external, "member/Cargo.toml", '[package]\nname = "outside-member"\n');
    await writeFixture(external, "member/src/lib.rs", "pub fn outside() {}\n");
    await symlink(external, join(root, "crates"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library rootpkg");
    expect(titles).not.toContain("Rust library outside-member");
  });

  it("does not map Rust entrypoints through symlinked source directories", async () => {
    const root = await fixtureRoot("clawpatch-rust-src-symlink-root-");
    const externalRoot = await fixtureRoot("clawpatch-rust-src-symlink-external-root-");
    const externalMember = await fixtureRoot("clawpatch-rust-src-symlink-external-member-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[package]\nname = "rootpkg"\n\n[workspace]\nmembers = ["member"]\n',
    );
    await writeFixture(root, "member/Cargo.toml", '[package]\nname = "memberpkg"\n');
    await writeFixture(externalRoot, "lib.rs", "pub fn outside() {}\n");
    await writeFixture(externalMember, "lib.rs", "pub fn outside() {}\n");
    await symlink(externalRoot, join(root, "src"), "dir");
    await symlink(externalMember, join(root, "member/src"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Rust library rootpkg");
    expect(titles).not.toContain("Rust library memberpkg");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
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

  it("maps SwiftPM executable targets, libraries, tests, and Swift defaults", async () => {
    const root = await fixtureRoot("clawpatch-swift-map-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SwiftFixture",
  targets: [
    .executableTarget(name: "Tool"),
    .target(name: "Core"),
    .testTarget(name: "CoreTests", dependencies: ["Core"])
  ]
)
`,
    );
    await writeFixture(
      root,
      "Sources/Tool/Tool.swift",
      "@main\nstruct Tool { static func main() {} }\n",
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func works() {}\n",
    );
    await writeFixture(
      root,
      "Tests/OtherTests/OtherTests.swift",
      "import Testing\n@Test func unrelated() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("swift");
    expect(project.detected.packageManagers).toContain("swiftpm");
    expect(project.detected.commands.typecheck).toBe("swift build");
    expect(project.detected.commands.test).toBe("swift test");
    expect(titles).toContain("Swift executable Tool");
    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift test suite CoreTests");
    expect(titles).toContain("Swift test suite OtherTests");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("ignores commented SwiftPM target declarations", async () => {
    const root = await fixtureRoot("clawpatch-swift-comments-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Comments",
  targets: [
    // .target(name: "Old"),
    /* .target(name: "BlockOld"), */
    /*
      disabled:
      /* nested */
      .target(name: "NestedOld"),
    */
    .target(name: "Core")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Old/Old.swift", "public struct Old {}\n");
    await writeFixture(root, "Sources/BlockOld/BlockOld.swift", "public struct BlockOld {}\n");
    await writeFixture(root, "Sources/NestedOld/NestedOld.swift", "public struct NestedOld {}\n");
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).not.toContain("Swift target Old");
    expect(titles).not.toContain("Swift target BlockOld");
    expect(titles).not.toContain("Swift target NestedOld");
  });

  it("ignores commented and string Swift main attributes", async () => {
    const root = await fixtureRoot("clawpatch-swift-main-comments-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "MainComments", targets: [.target(name: "Core")])
`,
    );
    await writeFixture(
      root,
      "Sources/Core/Core.swift",
      `/// Used by @main executables.
public struct Core {
  let marker = "@main"
}
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find((candidate) => candidate.title === "Swift target Core");

    expect(feature?.kind).toBe("library");
    expect(feature?.entrypoints[0]?.command).toBeNull();
  });

  it("uses manifest target names for SwiftPM custom paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-custom-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "CustomPath",
  targets: [
    .target(name: "Core", dependencies: [.target(name: "Util")], path: "Sources/Shared"),
    .target(name: "Util"),
    .testTarget(name: "CoreTests", dependencies: ["Core"], path: "CustomTests/CoreTests")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Shared/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Sources/Util/Util.swift", "public struct Util {}\n");
    await writeFixture(
      root,
      "CustomTests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func works() {}\n",
    );
    await writeFixture(
      root,
      "Tests/SharedTests/SharedTests.swift",
      "import Testing\n@Test func unrelated() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift target Util");
    expect(titles).not.toContain("Swift target Shared");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "CustomTests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("links SwiftPM tests from arbitrary manifest test paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-specs-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SpecsPath",
  targets: [
    .target(name: "Core"),
    .testTarget(name: "CoreTests", dependencies: ["Core"], path: "Specs")
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Specs/CoreTests.swift", "import Testing\n@Test func works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Specs/CoreTests.swift", command: "swift test" }],
    );
    expect(
      result.features.find((feature) => feature.title === "Swift test suite CoreTests")
        ?.entrypoints[0]?.path,
    ).toBe("Specs/CoreTests.swift");
  });

  it("links custom SwiftPM test targets by dependency", async () => {
    const root = await fixtureRoot("clawpatch-swift-custom-test-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "CustomTestName",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "UnitSpecs",
      dependencies: [
        .product(name: "FixtureSupport", package: "fixture", condition: .when(platforms: [.macOS])),
        "Core"
      ],
      path: "Specs"
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Specs/CoreSpec.swift", "import Testing\n@Test func works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Specs/CoreSpec.swift", command: "swift test" }],
    );
  });

  it("does not link SwiftPM external product names as local target dependencies", async () => {
    const root = await fixtureRoot("clawpatch-swift-external-product-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "ExternalProductName",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "ExternalSpecs",
      dependencies: [
        .product(name: "Core", package: "external-core")
      ],
      path: "ExternalSpecs"
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "ExternalSpecs/ExternalSpec.swift",
      "import Testing\n@Test func works() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [],
    );
  });

  it("links custom SwiftPM test targets at default test paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-default-custom-test-name-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "DefaultCustomTestName",
  targets: [
    .target(name: "Core"),
    .testTarget(name: "UnitSpecs", dependencies: ["Core"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/UnitSpecs/UnitSpecs.swift",
      "import Testing\n@Test func works() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/UnitSpecs/UnitSpecs.swift", command: "swift test" }],
    );
  });

  it("maps SwiftPM targets with root custom paths", async () => {
    const root = await fixtureRoot("clawpatch-swift-root-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "RootPath",
  targets: [
    .executableTarget(name: "Tool", path: "."),
    .testTarget(name: "ToolTests", dependencies: ["Tool"])
  ]
)
`,
    );
    await writeFixture(root, "main.swift", 'print("hi")\n');
    await writeFixture(root, "A.swift", "struct Helper {}\n");
    await writeFixture(
      root,
      "Tests/ToolTests/ToolTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable Tool",
    );

    expect(feature?.entrypoints[0]?.path).toBe("main.swift");
    expect(feature?.tests).toEqual([
      { path: "Tests/ToolTests/ToolTests.swift", command: "swift test" },
    ]);
    expect(result.features.map((candidate) => candidate.title)).toContain(
      "Swift test suite ToolTests",
    );
  });

  it("handles SwiftPM root test paths with source filters", async () => {
    const root = await fixtureRoot("clawpatch-swift-root-test-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "RootTestPath",
  targets: [
    .target(name: "Core"),
    .testTarget(
      name: "CoreTests",
      dependencies: ["Core"],
      path: ".",
      sources: ["Tests/CoreTests"]
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target Core");
    expect(titles).toContain("Swift test suite CoreTests");
    expect(titles).not.toContain("Swift test suite Core");
    expect(result.features.find((feature) => feature.title === "Swift target Core")?.tests).toEqual(
      [{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }],
    );
  });

  it("ignores SwiftPM custom paths that escape the repo", async () => {
    const root = await fixtureRoot("clawpatch-swift-escape-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Escape",
  targets: [
    .executableTarget(name: "Tool", path: "../outside")
  ]
)
`,
    );
    await writeFixture(
      root,
      "../outside/main.swift",
      "@main\nstruct Tool { static func main() {} }\n",
    );
    await writeFixture(root, "Sources/Tool/main.swift", 'print("fallback must not map")\n');

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Swift executable Tool");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  it("ignores SwiftPM custom paths through symlinks outside the repo", async () => {
    const root = await fixtureRoot("clawpatch-swift-symlink-path-");
    const external = await fixtureRoot("clawpatch-swift-external-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SymlinkPath",
  targets: [
    .target(name: "Outside", path: "linked/src")
  ]
)
`,
    );
    await writeFixture(external, "src/Outside.swift", "public struct Outside {}\n");
    await symlink(external, join(root, "linked"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Swift target Outside");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  it("does not seed swift test when a SwiftPM package has no tests", async () => {
    const root = await fixtureRoot("clawpatch-swift-no-tests-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "NoTests", targets: [.executableTarget(name: "NoTests")])
// .testTarget(name: "OldTests")
/*
  disabled:
  /* nested */
  .testTarget(name: "BlockOldTests")
*/
`,
    );
    await writeFixture(root, "Tests/fixtures/data.json", "{}\n");
    await writeFixture(
      root,
      "Sources/NoTests/NoTests.swift",
      "@main\nstruct NoTests { static func main() {} }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable NoTests",
    );

    expect(project.detected.commands.typecheck).toBe("swift build");
    expect(project.detected.commands.test).toBeNull();
    expect(feature?.tests).toEqual([]);
  });

  it("ignores symlinked SwiftPM test directories", async () => {
    const root = await fixtureRoot("clawpatch-swift-symlink-tests-");
    const external = await fixtureRoot("clawpatch-swift-external-tests-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(name: "NoTests", targets: [.executableTarget(name: "NoTests")])
`,
    );
    await writeFixture(root, "Sources/NoTests/main.swift", 'print("hi")\n');
    await writeFixture(
      external,
      "NoTestsTests/NoTestsTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );
    await symlink(external, join(root, "Tests"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable NoTests",
    );

    expect(project.detected.commands.test).toBeNull();
    expect(feature?.tests).toEqual([]);
  });

  it("uses manifest target names for flat SwiftPM source layouts", async () => {
    const root = await fixtureRoot("clawpatch-swift-flat-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "Flat",
  targets: [
    .executableTarget(name: "Flat"),
    .testTarget(name: "FlatTests", dependencies: ["Flat"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/main.swift", 'print("flat")\n');
    await writeFixture(
      root,
      "Tests/FlatTests/FlatTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const feature = result.features.find(
      (candidate) => candidate.title === "Swift executable Flat",
    );

    expect(feature).toBeDefined();
    expect(feature?.entrypoints[0]?.command).toBe("Flat");
    expect(feature?.entrypoints[0]?.path).toBe("Sources/main.swift");
    expect(feature?.tests).toEqual([
      { path: "Tests/FlatTests/FlatTests.swift", command: "swift test" },
    ]);
  });

  it("preserves SwiftPM source targets declared under Tests", async () => {
    const root = await fixtureRoot("clawpatch-swift-test-helper-target-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "TestHelper",
  targets: [
    .target(name: "TestResources", path: "Tests/TestResources"),
    .testTarget(
      name: "CoreTests",
      dependencies: ["TestResources"],
      path: "Tests/CoreTests"
    )
  ]
)
`,
    );
    await writeFixture(
      root,
      "Tests/TestResources/Resources.swift",
      "public struct TestResources {}\n",
    );
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func ok() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Swift target TestResources");
    expect(titles).not.toContain("Swift test suite TestResources");
    expect(
      result.features.find((feature) => feature.title === "Swift target TestResources")?.tests,
    ).toEqual([{ path: "Tests/CoreTests/CoreTests.swift", command: "swift test" }]);
  });

  it("preserves SwiftPM targets sharing a path with sources filters", async () => {
    const root = await fixtureRoot("clawpatch-swift-shared-source-path-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "SharedPath",
  targets: [
    .target(name: "Core", path: "Sources", sources: ["Core"]),
    .target(name: "Util", path: "Sources", sources: ["Util"]),
    .testTarget(
      name: "CoreTests",
      dependencies: ["Core"],
      path: "Tests",
      sources: ["CoreTests"]
    ),
    .testTarget(
      name: "UtilTests",
      dependencies: ["Util"],
      path: "Tests",
      sources: ["UtilTests"]
    )
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core/Core.swift", "public struct Core {}\n");
    await writeFixture(root, "Sources/Util/Util.swift", "public struct Util {}\n");
    await writeFixture(
      root,
      "Tests/CoreTests/CoreTests.swift",
      "import Testing\n@Test func core() {}\n",
    );
    await writeFixture(
      root,
      "Tests/UtilTests/UtilTests.swift",
      "import Testing\n@Test func util() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const core = result.features.find((feature) => feature.title === "Swift target Core");
    const util = result.features.find((feature) => feature.title === "Swift target Util");

    expect(core?.entrypoints[0]?.path).toBe("Sources/Core/Core.swift");
    expect(util?.entrypoints[0]?.path).toBe("Sources/Util/Util.swift");
    expect(core?.tests).toEqual([
      { path: "Tests/CoreTests/CoreTests.swift", command: "swift test" },
    ]);
    expect(util?.tests).toEqual([
      { path: "Tests/UtilTests/UtilTests.swift", command: "swift test" },
    ]);
  });

  it("maps SwiftPM source filters that point at files", async () => {
    const root = await fixtureRoot("clawpatch-swift-file-source-");
    await writeFixture(
      root,
      "Package.swift",
      `// swift-tools-version: 6.0
import PackageDescription
let package = Package(
  name: "FileSource",
  targets: [
    .target(name: "Core", path: "Sources", sources: ["Core.swift"])
  ]
)
`,
    );
    await writeFixture(root, "Sources/Core.swift", "public struct Core {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const core = result.features.find((feature) => feature.title === "Swift target Core");

    expect(core?.entrypoints[0]?.path).toBe("Sources/Core.swift");
  });
});
