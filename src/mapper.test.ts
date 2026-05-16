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

  it("maps Next routes inside Nx workspace projects", async () => {
    const root = await fixtureRoot("clawpatch-map-next-nx-workspace-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(root, "yarn.lock", "");
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "web", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify(
        {
          name: "web",
          sourceRoot: "apps/web/src",
          projectType: "application",
          targets: { test: {}, lint: {} },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/src/app/(dashboard)/users/[id]/page.tsx",
      "export default function Page() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/web/src/app/(dashboard)/users/[id]/page.test.tsx",
      "test('route', () => {});\n",
    );
    await writeFixture(
      root,
      "apps/web/src/app/api/things/route.ts",
      "export function GET() { return new Response('ok'); }\n",
    );
    await writeFixture(
      root,
      "apps/admin/package.json",
      JSON.stringify({ name: "admin", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/project.json",
      JSON.stringify({ name: "admin", targets: { test: {} } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/src/pages/settings.tsx",
      "export default function Settings() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const webRoute = result.features.find((feature) => feature.title === "web route /users/:id");
    const adminRoute = result.features.find((feature) => feature.title === "admin route /settings");

    expect(titles).toContain("web route /users/:id");
    expect(titles).toContain("web route /api/things");
    expect(titles).toContain("admin route /settings");
    expect(webRoute?.entrypoints[0]?.path).toBe("apps/web/src/app/(dashboard)/users/[id]/page.tsx");
    expect(webRoute?.entrypoints[0]?.route).toBe("/users/:id");
    expect(webRoute?.tags).toEqual(
      expect.arrayContaining(["project:web", "project-root:apps/web", "project-type:application"]),
    );
    expect(webRoute?.tests).toEqual([
      {
        path: "apps/web/src/app/(dashboard)/users/[id]/page.test.tsx",
        command: "yarn nx test web",
      },
    ]);
    expect(webRoute?.contextFiles).toContainEqual({
      path: "apps/web/project.json",
      reason: "project context",
    });
    expect(adminRoute?.tests.every((test) => test.command === "yarn nx test admin")).toBe(true);
  });

  it("maps Next routes inside Nx projects without package manifests", async () => {
    const root = await fixtureRoot("clawpatch-map-next-nx-no-package-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "workspace-root" }, null, 2));
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "apps/portal/project.json",
      JSON.stringify(
        {
          name: "portal",
          sourceRoot: "apps/portal/src",
          projectType: "application",
          targets: { test: {} },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/portal/src/app/account/page.tsx",
      "export default function Account() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/portal/src/app/account/page.test.tsx",
      "test('route', () => {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "portal route /account");

    expect(route?.entrypoints[0]?.path).toBe("apps/portal/src/app/account/page.tsx");
    expect(route?.tests).toEqual([
      { path: "apps/portal/src/app/account/page.test.tsx", command: "pnpm nx test portal" },
    ]);
    expect(route?.tags).toEqual(
      expect.arrayContaining([
        "project:portal",
        "project-root:apps/portal",
        "project-type:application",
      ]),
    );
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
      JSON.stringify({ name: "web", scripts: { test: "vitest run" } }, null, 2),
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

  it("maps Ruby metadata, executables, source groups, and tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(
      root,
      "fixture.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'fixture-ruby'\n  spec.add_dependency 'redis'\nend\n",
    );
    await writeFixture(root, "Rakefile", "task :default\n");
    await writeFixture(root, "exe/fixture", "#!/usr/bin/env ruby\nputs 'ok'\n");
    await writeFixture(root, "script/helper.rb", "#!/usr/bin/env ruby\nputs 'helper'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(
      root,
      "lib/fixture/client.rb",
      "module Fixture\n  class Client\n  end\nend\n",
    );
    for (let index = 0; index < 12; index += 1) {
      await writeFixture(
        root,
        `lib/fixture/type/type${String(index).padStart(2, "0")}.rb`,
        "module Fixture\nend\n",
      );
    }
    await writeFixture(root, "spec/fixture/client_spec.rb", "RSpec.describe Fixture::Client\n");
    await writeFixture(root, "vendor/bundle/ignored.rb", "module Ignored\nend\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rubyProject = result.features.find(
      (feature) => feature.title === "Ruby project fixture-ruby",
    );
    const cli = result.features.find((feature) => feature.title === "Ruby CLI command fixture");
    const source = result.features.find((feature) => feature.title === "Ruby source lib/fixture");

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
    expect(titles).toContain("Ruby project fixture-ruby");
    expect(titles).toContain("Ruby CLI command fixture");
    expect(titles).toContain("Ruby CLI command helper.rb");
    expect(titles).toContain("Ruby Rake tasks");
    expect(titles).toContain("Ruby source lib");
    expect(titles).toContain("Ruby source lib/fixture");
    expect(titles).toContain("Ruby source lib/fixture/type");
    expect(titles).toContain("Ruby test suite spec");
    expect(rubyProject?.ownedFiles).toContainEqual({
      path: "fixture.gemspec",
      reason: "ruby project metadata",
    });
    expect(rubyProject?.trustBoundaries).toEqual(
      expect.arrayContaining(["database", "network", "serialization"]),
    );
    expect(cli?.entrypoints[0]?.path).toBe("exe/fixture");
    expect(source?.ownedFiles.map((ref) => ref.path)).toContain("lib/fixture/client.rb");
    expect(source?.tests).toEqual([
      { path: "spec/fixture/client_spec.rb", command: "bundle exec rspec" },
    ]);
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((ref) => ref.path)),
    ).not.toContain("vendor/bundle/ignored.rb");
  });

  it("treats gems.rb projects as Bundler-backed", async () => {
    const root = await fixtureRoot("clawpatch-map-gems-rb-");
    await writeFixture(
      root,
      "gems.rb",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "spec/fixture_spec.rb", "RSpec.describe Fixture\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
  });

  it("maps Gemfile-only Jekyll sites without mistaking dependencies for project names", async () => {
    const root = await fixtureRoot("clawpatch-map-jekyll-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'jekyll'\ngem 'jekyll-feed'\ngem 'hive-ruby'\n",
    );
    await writeFixture(root, "_config.yml", "title: Docs\n");
    await writeFixture(root, "index.md", "---\nlayout: home\n---\n");
    await writeFixture(root, "_layouts/default.html", "{{ content }}\n");
    await writeFixture(root, "_includes/header.html", "<header></header>\n");
    await writeFixture(root, "_sass/site.scss", "body { color: black; }\n");
    await writeFixture(root, "assets/main.scss", "---\n---\n@import 'site';\n");
    await writeFixture(root, "_posts/2021-01-01-one.md", "---\ntitle: One\n---\n");
    await writeFixture(root, "_posts/2022-01-01-two.md", "---\ntitle: Two\n---\n");
    await writeFixture(root, "_topics/ruby.md", "---\ntitle: Ruby\n---\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rubyProject = result.features.find(
      (feature) => feature.title === `Ruby project ${root.split("/").at(-1)}`,
    );
    const siteConfig = result.features.find(
      (feature) => feature.title === "Jekyll site configuration",
    );

    expect(project.detected.frameworks).toContain("jekyll");
    expect(titles).toContain(`Ruby project ${root.split("/").at(-1)}`);
    expect(titles).not.toContain("Ruby project jekyll");
    expect(titles).toContain("Jekyll site configuration");
    expect(titles).toContain("Jekyll theme _layouts");
    expect(titles).toContain("Jekyll theme _includes");
    expect(titles).toContain("Jekyll theme _sass");
    expect(titles).toContain("Jekyll content _posts/2021");
    expect(titles).toContain("Jekyll content _posts/2022");
    expect(titles).toContain("Jekyll content _topics");
    expect(rubyProject?.entrypoints[0]?.symbol).toBeNull();
    expect(siteConfig?.ownedFiles.map((ref) => ref.path)).toContain("index.md");
  });

  it("maps Rails app structure and skips common Rails binstubs", async () => {
    const root = await fixtureRoot("clawpatch-map-rails-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "rails-webpacker-shell", dependencies: { "@rails/ujs": "1.0.0" } }),
    );
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n");
    await writeFixture(root, "config/application.rb", "module FixtureRails\nend\n");
    await writeFixture(root, "config/routes.rb", "Rails.application.routes.draw do\nend\n");
    await writeFixture(root, "config/secrets.yml", "redacted: placeholder\n");
    await writeFixture(
      root,
      "config/environments/test.rb",
      "Rails.application.configure do\nend\n",
    );
    await writeFixture(
      root,
      "config/initializers/filter.rb",
      "Rails.application.config.filter_parameters += [:password]\n",
    );
    await writeFixture(root, "db/schema.rb", "ActiveRecord::Schema.define do\nend\n");
    await writeFixture(
      root,
      "db/migrate/20200101000000_create_widgets.rb",
      "class CreateWidgets < ActiveRecord::Migration[6.1]\nend\n",
    );
    await writeFixture(
      root,
      "bin/rails",
      "#!/usr/bin/env ruby\nAPP_PATH = '../config/application'\n",
    );
    await writeFixture(
      root,
      "app/controllers/widgets_controller.rb",
      "class WidgetsController < ApplicationController\nend\n",
    );
    await writeFixture(root, "app/models/widget.rb", "class Widget < ApplicationRecord\nend\n");
    await writeFixture(root, "app/views/widgets/index.html.haml", "%h1 Widgets\n");
    await writeFixture(root, "app/views/widgets/index.json.jbuilder", "json.widgets []\n");
    await writeFixture(root, "app/assets/javascripts/widgets.coffee", "console.log 'widgets'\n");
    await writeFixture(root, "app/assets/stylesheets/widgets.scss", ".widgets { color: black; }\n");
    await writeFixture(
      root,
      "app/javascript/controllers/widgets_controller.js",
      "export function connect() {}\n",
    );
    await writeFixture(root, "src/client.ts", "export function client() {}\n");
    await writeFixture(root, "lib/client.ts", "export function libClient() {}\n");
    await writeFixture(root, "pages/home.tsx", "export function Home() { return null; }\n");
    await writeFixture(
      root,
      "test/controllers/widgets_controller_test.rb",
      "class WidgetsControllerTest\nend\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const referencedFiles = result.features.flatMap((feature) => [
      ...feature.ownedFiles.map((ref) => ref.path),
      ...feature.contextFiles.map((ref) => ref.path),
    ]);
    const rubyProject = result.features.find(
      (feature) => feature.title === `Ruby project ${root.split("/").at(-1)}`,
    );
    const railsConfig = result.features.find(
      (feature) => feature.title === "Rails application configuration",
    );

    expect(project.detected.frameworks).toContain("rails");
    expect(titles).not.toContain("Ruby CLI command rails");
    expect(titles).not.toContain("Node source app");
    expect(titles).not.toContain("Node source app/assets");
    expect(titles).toContain("Node source app/javascript");
    expect(titles).toContain("Node source src");
    expect(titles).toContain("Node source lib");
    expect(titles).toContain("Node source pages");
    expect(titles).toContain("Rails application configuration");
    expect(titles).toContain("Rails database schema and migrations");
    expect(titles).toContain("Rails views app/views");
    expect(titles).toContain("Rails assets app/assets");
    expect(rubyProject?.trustBoundaries).toEqual(
      expect.arrayContaining(["database", "network", "serialization"]),
    );
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).toContain("config/routes.rb");
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain("config/secrets.yml");
    expect(
      result.features.filter((feature) =>
        feature.ownedFiles.some(
          (ref) => ref.path === "app/javascript/controllers/widgets_controller.js",
        ),
      ),
    ).toHaveLength(1);
    expect(referencedFiles).not.toContain("config/secrets.yml");
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

  it("maps React Router routes and components in a nested frontend app", async () => {
    const root = await fixtureRoot("clawpatch-react-router-map-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - frontend\n");
    await writeFixture(
      root,
      "frontend/package.json",
      JSON.stringify(
        {
          name: "fixture-frontend",
          scripts: { test: "vitest run" },
          dependencies: {
            react: "1.0.0",
            "react-dom": "1.0.0",
            "react-router-dom": "1.0.0",
          },
          devDependencies: { vite: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "frontend/src/App.tsx",
      [
        "import React, { lazy, Suspense } from 'react';",
        "import { Navigate, Route, Routes } from 'react-router-dom';",
        "const CasesPage = lazy(() => import('./pages/CasesPage'));",
        "const ReactLazyPage = React.lazy(() => import('./pages/ReactLazyPage'));",
        "import HomePage, { loader } from './pages/HomePage';",
        "import ReportsPage from './pages/ReportsPage';",
        "import SettingsPage from './pages/SettingsPage';",
        "import SuspensePage from './pages/SuspensePage';",
        "import UserPage from './pages/UserPage';",
        "import LinkedPage from './pages/LinkedPage';",
        "import ErrorPage from './pages/ErrorPage';",
        "import DashboardPage from './pages/DashboardPage';",
        "import Icon from './pages/Icon';",
        "import Widget from './pages/Widget';",
        "import RequireAuth from './RequireAuth';",
        "import EscapePage from '../../../outside';",
        "export default function App() {",
        "  return <Routes>",
        '    {/* <Route path="/old" element={<OldPage />} /> */}',
        '    // <Route path="/line-old" element={<OldPage />} />',
        "    <Route index element={<HomePage />} />",
        '    <Route path="/" element={<Navigate to="/cases" replace />} />',
        '    <Route path="/cases" element={<CasesPage />} />',
        '    <Route path="/react-lazy" element={<ReactLazyPage />} />',
        '    <Route path="/users">',
        '      <Route path=":id" element={<UserPage />} />',
        "    </Route>",
        "    <Route index={false} element={<ReportsPage />} />",
        '    <Route path="/suspense" element={<Suspense><SuspensePage /></Suspense>} />',
        '    <Route path="/with-error" element={<ReportsPage />} errorElement={<ErrorPage />} />',
        '    <Route path="/dashboard" element={<DashboardPage icon={<Icon />} />} />',
        '    <Route path="/nested-wrapper" element={<Suspense><RequireAuth><ReportsPage /></RequireAuth></Suspense>} />',
        '    <Route path="/handle" handle={{ crumb: <Widget element={<HomePage />} /> }} element={<SettingsPage />} />',
        '    <Route id="a > b" path="/quoted-id" element={<SettingsPage />} />',
        "    <Route path={HOME} element={<ReportsPage />} />",
        '    <Route path={"/quoted"} element={<ReportsPage />} />',
        '    <Route element={<Widget path="/inner" />} />',
        '    <Route element={<ReportsPage />} path="/reports" />',
        '    <Route path="/settings" element={<SettingsPage />} />',
        '    <Route path="/linked" element={<LinkedPage />} />',
        '    <Route path="/escape" element={<EscapePage />} />',
        '  </Routes>; // <Route path="/trailing-old" element={<OldPage />} />',
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "../outside.tsx",
      "export default function EscapePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/App.test.tsx",
      [
        "import { MemoryRouter, Route, Routes } from 'react-router-dom';",
        "function TestOnlyPage() { return null; }",
        "test('fixture route', () => <MemoryRouter><Routes>",
        '  <Route path="/test-only" element={<TestOnlyPage />} />',
        "</Routes></MemoryRouter>);",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "frontend/src/pages/CasesPage.tsx",
      "export default function CasesPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/CasesPage.test.tsx",
      "test('cases page', () => {});\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "frontend/src/shared/util.test.tsx", "test('util', () => {});\n");
    await writeFixture(
      root,
      "frontend/src/pages/SettingsPage.tsx",
      "export default function SettingsPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/SuspensePage.tsx",
      "export default function SuspensePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/ReportsPage.tsx",
      "export default function ReportsPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/ErrorPage.tsx",
      "export default function ErrorPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/DashboardPage.tsx",
      "export default function DashboardPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/Icon.tsx",
      "export default function Icon() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/Widget.tsx",
      "export default function Widget() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/RequireAuth.tsx",
      "export default function RequireAuth({ children }: { children: unknown }) { return children; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/ReactLazyPage.tsx",
      "export default function ReactLazyPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "frontend/src/pages/UserPage.tsx",
      "export default function UserPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "../outside-linked.tsx",
      "export default function LinkedPage() { return null; }\n",
    );
    await symlink(
      join(root, "../outside-linked.tsx"),
      join(root, "frontend/src/pages/LinkedPage.tsx"),
    );
    await writeFixture(
      root,
      "frontend/src/components/Dialog.tsx",
      "export default function Dialog() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const home = result.features.find((feature) => feature.title === "React route /");
    const cases = result.features.find((feature) => feature.title === "React route /cases");
    const reactLazy = result.features.find(
      (feature) => feature.title === "React route /react-lazy",
    );
    const reports = result.features.find((feature) => feature.title === "React route /reports");
    const settings = result.features.find((feature) => feature.title === "React route /settings");
    const suspense = result.features.find((feature) => feature.title === "React route /suspense");
    const withError = result.features.find(
      (feature) => feature.title === "React route /with-error",
    );
    const dashboard = result.features.find((feature) => feature.title === "React route /dashboard");
    const nestedWrapper = result.features.find(
      (feature) => feature.title === "React route /nested-wrapper",
    );
    const handle = result.features.find((feature) => feature.title === "React route /handle");
    const quotedId = result.features.find((feature) => feature.title === "React route /quoted-id");
    const quoted = result.features.find((feature) => feature.title === "React route /quoted");
    const user = result.features.find((feature) => feature.title === "React route /users/:id");
    const linked = result.features.find((feature) => feature.title === "React route /linked");
    const escape = result.features.find((feature) => feature.title === "React route /escape");
    const dialog = result.features.find((feature) => feature.title === "React component Dialog");

    expect(titles).toContain("Node package fixture-frontend");
    expect(home?.entrypoints[0]?.path).toBe("frontend/src/pages/HomePage.tsx");
    expect(cases?.source).toBe("react-router-route");
    expect(cases?.entrypoints[0]?.path).toBe("frontend/src/pages/CasesPage.tsx");
    expect(cases?.contextFiles).toContainEqual({
      path: "frontend/src/App.tsx",
      reason: "route declaration",
    });
    expect(cases?.tests).toEqual([
      {
        path: "frontend/src/pages/CasesPage.test.tsx",
        command: "pnpm --dir frontend test",
      },
    ]);
    expect(reactLazy?.entrypoints[0]?.path).toBe("frontend/src/pages/ReactLazyPage.tsx");
    expect(reports?.entrypoints[0]?.path).toBe("frontend/src/pages/ReportsPage.tsx");
    expect(withError?.entrypoints[0]?.path).toBe("frontend/src/pages/ReportsPage.tsx");
    expect(dashboard?.entrypoints[0]?.path).toBe("frontend/src/pages/DashboardPage.tsx");
    expect(nestedWrapper?.entrypoints[0]?.path).toBe("frontend/src/pages/ReportsPage.tsx");
    expect(handle?.entrypoints[0]?.path).toBe("frontend/src/pages/SettingsPage.tsx");
    expect(quotedId?.entrypoints[0]?.path).toBe("frontend/src/pages/SettingsPage.tsx");
    expect(quoted?.entrypoints[0]?.path).toBe("frontend/src/pages/ReportsPage.tsx");
    expect(settings?.entrypoints[0]?.path).toBe("frontend/src/pages/SettingsPage.tsx");
    expect(suspense?.entrypoints[0]?.path).toBe("frontend/src/pages/SuspensePage.tsx");
    expect(user?.entrypoints[0]?.path).toBe("frontend/src/pages/UserPage.tsx");
    expect(linked?.entrypoints[0]?.path).toBe("frontend/src/App.tsx");
    expect(escape?.entrypoints[0]?.path).toBe("frontend/src/App.tsx");
    expect(titles).not.toContain("React route /old");
    expect(titles).not.toContain("React route /line-old");
    expect(titles).not.toContain("React route /trailing-old");
    expect(titles).not.toContain("React route /test-only");
    expect(titles).not.toContain("React route /inner");
    expect(titles).not.toContain("React route /HOME");
    expect(titles.filter((title) => title === "React route /")).toHaveLength(1);
    expect(dialog?.source).toBe("react-component");
    expect(dialog?.ownedFiles).toEqual([
      { path: "frontend/src/components/Dialog.tsx", reason: "component implementation" },
    ]);
  });

  it("does not map custom React Route components as React Router routes", async () => {
    const root = await fixtureRoot("clawpatch-react-custom-route-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "// import { Route } from 'react-router-dom';",
        "const example = \"import { Route } from 'react-router-dom';\";",
        "function Route(_props: { path: string }) { return null; }",
        "function Page() { return null; }",
        'export function App() { return <Route path="/custom" element={<Page />} />; }',
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("React route /custom");
  });

  it("maps React Router routes through aliased Route imports only", async () => {
    const root = await fixtureRoot("clawpatch-react-aliased-route-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route as RouterRoute, Routes } from 'react-router-dom';",
        "import RealPage from './RealPage';",
        "function Route(_props: { path: string }) { return null; }",
        "function FakePage() { return null; }",
        "export function App() { return <Routes>",
        '  <Route path="/custom"><FakePage /></Route>',
        '  <RouterRoute path="/real" element={<RealPage />} />',
        "</Routes>; }",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/RealPage.tsx",
      "export default function RealPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("React route /real");
    expect(titles).not.toContain("React route /custom");
  });

  it("does not map React Router children under unresolved parent paths", async () => {
    const root = await fixtureRoot("clawpatch-react-unresolved-parent-route-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import AdminUsers from './AdminUsers';",
        "import PublicPage from './PublicPage';",
        "const ADMIN_BASE = '/admin';",
        "export function App() {",
        "  return <Routes>",
        "    <Route path={ADMIN_BASE}>",
        '      <Route path="users" element={<AdminUsers />} />',
        "    </Route>",
        "    <Route element={<PublicPage />}>",
        '      <Route path="/public" element={<PublicPage />} />',
        "    </Route>",
        "  </Routes>;",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/AdminUsers.tsx",
      "export default function AdminUsers() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/PublicPage.tsx",
      "export default function PublicPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("React route /users");
    expect(titles).toContain("React route /public");
  });

  it("keeps React index tests scoped to their component directory", async () => {
    const root = await fixtureRoot("clawpatch-react-index-tests-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import Home from './pages/Home';",
        "export function App() {",
        "  return <Routes>",
        '    <Route path="/home" element={<Home />} />',
        "  </Routes>;",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/Home/index.tsx",
      "export default function Home() { return null; }\n",
    );
    await writeFixture(root, "src/pages/Home/index.test.tsx", "test('home', () => {});\n");
    await writeFixture(root, "src/pages/Other/index.test.tsx", "test('other', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const home = result.features.find((feature) => feature.title === "React route /home");

    expect(home?.entrypoints[0]?.path).toBe("src/pages/Home/index.tsx");
    expect(home?.tests).toEqual([
      { path: "src/pages/Home/index.test.tsx", command: "npm run test" },
    ]);
  });

  it("unwraps React Router fragment and member-expression route wrappers", async () => {
    const root = await fixtureRoot("clawpatch-react-route-wrappers-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import React from 'react';",
        "import { Route, Routes } from 'react-router-dom';",
        "import FragmentPage from './pages/FragmentPage';",
        "import SuspensePage from './pages/SuspensePage';",
        "// import FragmentPage from './pages/WrongPage';",
        "const example = '<Route path=\"/fake\" element={<FragmentPage />} />';",
        "export function App() {",
        "  return <Routes>",
        '    <Route path="/fragment" element={<><FragmentPage /></>} />',
        '    <Route path="/member" element={<React.Suspense><SuspensePage /></React.Suspense>} />',
        "  </Routes>;",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/FragmentPage.tsx",
      "export default function FragmentPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/SuspensePage.tsx",
      "export default function SuspensePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/WrongPage.tsx",
      "export default function WrongPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const fragment = result.features.find((feature) => feature.title === "React route /fragment");
    const member = result.features.find((feature) => feature.title === "React route /member");

    expect(fragment?.entrypoints[0]?.path).toBe("src/pages/FragmentPage.tsx");
    expect(member?.entrypoints[0]?.path).toBe("src/pages/SuspensePage.tsx");
    expect(result.features.map((feature) => feature.title)).not.toContain("React route /fake");
  });

  it("preserves React Router wildcard paths while stripping block comments", async () => {
    const root = await fixtureRoot("clawpatch-react-wildcard-comment-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import AdminPage from './AdminPage';",
        "import FallbackPage from './FallbackPage';",
        "export function App() {",
        "  return <Routes>",
        '    <Route path="/admin/*" element={<AdminPage />} />',
        "    {/* old catch-all route */}",
        '    <Route path="/*" element={<FallbackPage />} />',
        "  </Routes>;",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/AdminPage.tsx",
      "export default function AdminPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/FallbackPage.tsx",
      "export default function FallbackPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("React route /admin/*");
    expect(titles).toContain("React route /*");
  });

  it("maps unambiguous React Router conditional route elements", async () => {
    const root = await fixtureRoot("clawpatch-react-conditional-element-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Navigate, Route, Routes } from 'react-router-dom';",
        "import AdminPage from './AdminPage';",
        "import DashboardPage from './DashboardPage';",
        "import LoginPage from './LoginPage';",
        "export function App() {",
        "  return <Routes>",
        '    <Route path="/login" element={isAuthed ? <Navigate to="/" /> : <LoginPage />} />',
        '    <Route path="/ambiguous" element={isAuthed ? <DashboardPage /> : <AdminPage />} />',
        "  </Routes>;",
        "}",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/AdminPage.tsx",
      "export default function AdminPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/DashboardPage.tsx",
      "export default function DashboardPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/LoginPage.tsx",
      "export default function LoginPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const login = result.features.find((feature) => feature.title === "React route /login");
    const titles = result.features.map((feature) => feature.title);

    expect(login?.entrypoints[0]?.path).toBe("src/LoginPage.tsx");
    expect(titles).not.toContain("React route /ambiguous");
  });

  it("does not discover React packages through symlinked package roots", async () => {
    const root = await fixtureRoot("clawpatch-react-symlink-package-");
    const outside = join(root, "../outside-react-package");
    const outsidePackages = join(root, "../outside-react-packages");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await writeFixture(
      root,
      "../outside-react-package/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "../outside-react-package/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "function OutsidePage() { return null; }",
        'export function App() { return <Routes><Route path="/outside" element={<OutsidePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "../outside-react-packages/app/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "../outside-react-packages/app/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "function WorkspacePage() { return null; }",
        'export function App() { return <Routes><Route path="/workspace-outside" element={<WorkspacePage />} /></Routes>; }',
      ].join("\n"),
    );
    await symlink(outside, join(root, "frontend"), "dir");
    await symlink(outsidePackages, join(root, "packages"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain("React route /outside");
    expect(result.features.map((feature) => feature.title)).not.toContain(
      "React route /workspace-outside",
    );
  });

  it("discovers React packages from workspace globs and honors excludes", async () => {
    const root = await fixtureRoot("clawpatch-react-workspace-glob-");
    await writeFixture(
      root,
      "pnpm-workspace.yaml",
      "packages:\n  - libs/*\n  - libs/**/plugins/*\n  - packages/*\n  - '!./packages/legacy'\n",
    );
    await writeFixture(
      root,
      "libs/web/package.json",
      JSON.stringify(
        { peerDependencies: { react: "1.0.0" }, dependencies: { "react-router-dom": "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "libs/web/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "libs/web/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "libs/suite/plugins/admin/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "libs/suite/plugins/admin/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import PluginPage from './PluginPage';",
        'export function App() { return <Routes><Route path="/plugin" element={<PluginPage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "libs/suite/plugins/admin/src/PluginPage.tsx",
      "export default function PluginPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import WebPage from './WebPage';",
        'export function App() { return <Routes><Route path="/web" element={<WebPage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/web/src/WebPage.tsx",
      "export default function WebPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "packages/legacy/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "packages/legacy/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import LegacyPage from './LegacyPage';",
        'export function App() { return <Routes><Route path="/legacy" element={<LegacyPage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "packages/legacy/src/LegacyPage.tsx",
      "export default function LegacyPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "libs/suite/node_modules/bad/plugins/ignored/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "libs/suite/node_modules/bad/plugins/ignored/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import IgnoredPage from './IgnoredPage';",
        'export function App() { return <Routes><Route path="/ignored" element={<IgnoredPage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "libs/suite/node_modules/bad/plugins/ignored/src/IgnoredPage.tsx",
      "export default function IgnoredPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("React route /home");
    expect(titles).toContain("React route /plugin");
    expect(titles).toContain("React route /web");
    expect(titles).not.toContain("React route /legacy");
    expect(titles).not.toContain("React route /ignored");
  });

  it("uses nested React package manager lockfiles for test commands", async () => {
    const root = await fixtureRoot("clawpatch-react-nested-pm-");
    await writeFixture(
      root,
      "frontend/package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "frontend/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    await writeFixture(
      root,
      "frontend/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "frontend/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "frontend/src/pages/HomePage.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const home = result.features.find((feature) => feature.title === "React route /home");

    expect(home?.tests).toEqual([
      { path: "frontend/src/pages/HomePage.test.tsx", command: "pnpm --dir frontend test" },
    ]);
  });

  it("honors package-local npm lockfiles in React packages", async () => {
    const root = await fixtureRoot("clawpatch-react-nested-npm-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - frontend\n");
    await writeFixture(
      root,
      "frontend/package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "frontend/package-lock.json", "{}\n");
    await writeFixture(
      root,
      "frontend/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "frontend/src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "frontend/src/pages/HomePage.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const home = result.features.find((feature) => feature.title === "React route /home");

    expect(home?.tests).toEqual([
      { path: "frontend/src/pages/HomePage.test.tsx", command: "npm --prefix frontend run test" },
    ]);
  });

  it("keeps React routes after block comments with URL-looking text", async () => {
    const root = await fixtureRoot("clawpatch-react-block-comment-url-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "/* see https://example.com */",
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("React route /home");
  });

  it("includes app-root React route tests", async () => {
    const root = await fixtureRoot("clawpatch-react-app-tests-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "app/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './routes/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/routes/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "app/routes/HomePage.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "React route /home");

    expect(route?.tests).toEqual([
      { path: "app/routes/HomePage.test.tsx", command: "npm run test" },
    ]);
  });

  it("uses bun run for root React package scripts", async () => {
    const root = await fixtureRoot("clawpatch-react-root-bun-");
    await writeFixture(root, "bun.lockb", "");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(root, "src/pages/HomePage.test.tsx", "test('home', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const home = result.features.find((feature) => feature.title === "React route /home");

    expect(home?.tests).toEqual([{ path: "src/pages/HomePage.test.tsx", command: "bun run test" }]);
  });

  it("ignores import-like strings when resolving React route components", async () => {
    const root = await fixtureRoot("clawpatch-react-string-import-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import Home from './Home';",
        "const example = \"import Home from './Fake';\";",
        'export function App() { return <Routes><Route path="/home" element={<Home />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(root, "src/Home.tsx", "export default function Home() { return null; }\n");
    await writeFixture(root, "src/Fake.tsx", "export default function Fake() { return null; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const home = result.features.find((feature) => feature.title === "React route /home");

    expect(home?.entrypoints[0]?.path).toBe("src/Home.tsx");
  });

  it("ignores import-like strings when collecting React context files", async () => {
    const root = await fixtureRoot("clawpatch-react-string-context-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          dependencies: { react: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/components/Dialog.tsx",
      [
        "const example = \"import Admin from '../Admin';\";",
        "import './Dialog.css';",
        "export default function Dialog() { return null; }",
      ].join("\n"),
    );
    await writeFixture(root, "src/components/Dialog.css", ".dialog { color: red; }\n");
    await writeFixture(root, "src/Admin.tsx", "export default function Admin() { return null; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const dialog = result.features.find((feature) => feature.title === "React component Dialog");

    expect(dialog?.contextFiles).not.toContainEqual({
      path: "src/Admin.tsx",
      reason: "direct import",
    });
    expect(dialog?.contextFiles).toContainEqual({
      path: "src/components/Dialog.css",
      reason: "direct import",
    });
  });

  it("keeps React routes after quoted JSX text", async () => {
    const root = await fixtureRoot("clawpatch-react-jsx-text-quote-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        "function Copy() { return <p>Don't miss this</p>; }",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("React route /home");
  });

  it("does not add binary React imports as context files", async () => {
    const root = await fixtureRoot("clawpatch-react-binary-import-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/components/Logo.tsx",
      [
        "import logo from './logo.png';",
        "import './Logo.css';",
        "export default function Logo() { return <img src={logo} />; }",
      ].join("\n"),
    );
    await writeFixture(root, "src/components/logo.png", "not real png\n");
    await writeFixture(root, "src/components/Logo.css", ".logo { display: block; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const logo = result.features.find((feature) => feature.title === "React component Logo");

    expect(logo?.contextFiles).not.toContainEqual({
      path: "src/components/logo.png",
      reason: "direct import",
    });
    expect(logo?.contextFiles).toContainEqual({
      path: "src/components/Logo.css",
      reason: "direct import",
    });
  });

  it("does not map React Storybook support files as route or component features", async () => {
    const root = await fixtureRoot("clawpatch-react-storybook-support-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import HomePage from './pages/HomePage';",
        'export function App() { return <Routes><Route path="/home" element={<HomePage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/HomePage.tsx",
      "export default function HomePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/pages/HomePage.stories.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "function StoryOnlyPage() { return null; }",
        'export default { title: "HomePage" };',
        'export const Story = () => <Routes><Route path="/story" element={<StoryOnlyPage />} /></Routes>;',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/components/Button.stories.tsx",
      "export default { title: 'Button' };\n",
    );
    await writeFixture(
      root,
      "src/stories/StoryPage.tsx",
      "export default function StoryPage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/components/fixtures/FakeRoute.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "function FakePage() { return null; }",
        'export const Fake = () => <Routes><Route path="/fixture" element={<FakePage />} /></Routes>;',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/components/__fixtures__/FixturePage.tsx",
      "export default function FixturePage() { return null; }\n",
    );
    await writeFixture(
      root,
      "src/testdata/TestDataPage.tsx",
      "export default function TestDataPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("React route /home");
    expect(titles).not.toContain("React route /story");
    expect(titles).not.toContain("React route /fixture");
    expect(titles).not.toContain("React component HomePage.stories");
    expect(titles).not.toContain("React component Button.stories");
    expect(titles).not.toContain("React component StoryPage");
    expect(titles).not.toContain("React component FakeRoute");
    expect(titles).not.toContain("React component FixturePage");
    expect(titles).not.toContain("React component TestDataPage");
  });

  it("discovers nested React packages without recursive file walks", async () => {
    const root = await fixtureRoot("clawpatch-react-nested-fallback-package-");
    await writeFixture(
      root,
      "frontend/packages/admin/package.json",
      JSON.stringify({ dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "frontend/packages/admin/src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import AdminPage from './AdminPage';",
        'export function App() { return <Routes><Route path="/admin" element={<AdminPage />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "frontend/packages/admin/src/AdminPage.tsx",
      "export default function AdminPage() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("React route /admin");
  });

  it("prioritizes exact React tests before same-directory fallback tests", async () => {
    const root = await fixtureRoot("clawpatch-react-exact-tests-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          scripts: { test: "vitest run" },
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import Foo from './pages/Foo';",
        'export function App() { return <Routes><Route path="/foo" element={<Foo />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/Foo.tsx",
      "export default function Foo() { return null; }\n",
    );
    for (let index = 0; index < 9; index += 1) {
      await writeFixture(root, `src/pages/A${index}.test.tsx`, "test('nearby', () => {});\n");
    }
    await writeFixture(root, "src/pages/Foo.test.tsx", "test('foo', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const foo = result.features.find((feature) => feature.title === "React route /foo");

    expect(foo?.tests[0]).toEqual({ path: "src/pages/Foo.test.tsx", command: "npm run test" });
  });

  it("refreshes React direct import context between map runs", async () => {
    const root = await fixtureRoot("clawpatch-react-cache-refresh-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          dependencies: { react: "1.0.0", "react-router-dom": "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/App.tsx",
      [
        "import { Route, Routes } from 'react-router-dom';",
        "import Home from './pages/Home';",
        'export function App() { return <Routes><Route path="/home" element={<Home />} /></Routes>; }',
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/pages/Home.tsx",
      ["import A from './A';", "export default function Home() { return <A />; }"].join("\n"),
    );
    await writeFixture(root, "src/pages/A.tsx", "export default function A() { return null; }\n");
    await writeFixture(root, "src/pages/B.tsx", "export default function B() { return null; }\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    await writeFixture(
      root,
      "src/pages/Home.tsx",
      ["import B from './B';", "export default function Home() { return <B />; }"].join("\n"),
    );
    const second = await mapFeatures(root, project, first.features);
    const route = second.features.find((feature) => feature.title === "React route /home");

    expect(route?.contextFiles).toContainEqual({
      path: "src/pages/B.tsx",
      reason: "direct import",
    });
    expect(route?.contextFiles).not.toContainEqual({
      path: "src/pages/A.tsx",
      reason: "direct import",
    });
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

    const blackRoot = await fixtureRoot("clawpatch-python-black-");
    await writeFixture(blackRoot, "requirements.txt", "black\n");
    expect((await detectProject(blackRoot)).detected.commands.format).toBe("black --check .");

    const uvBlackRoot = await fixtureRoot("clawpatch-python-uv-black-");
    await writeFixture(
      uvBlackRoot,
      "pyproject.toml",
      '[project]\nname = "uv-black"\ndependencies = ["black"]\n',
    );
    await writeFixture(uvBlackRoot, "uv.lock", "");
    expect((await detectProject(uvBlackRoot)).detected.commands.format).toBe(
      "uv run black --check .",
    );

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

  it("maps setup.cfg Python project names and console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-setup-cfg-entry-points-");
    await writeFixture(
      root,
      "setup.cfg",
      [
        "[metadata]",
        "name = legacy-cli",
        "",
        "[options.entry_points]",
        "console_scripts =",
        "    legacy = legacy.cli:main",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "legacy/cli.py", "def main():\n    pass\n");
    await writeFixture(root, "tests/test_cli.py", "def test_cli():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command legacy");

    expect(titles).toContain("Python project legacy-cli");
    expect(cli?.entrypoints[0]).toMatchObject({ path: "legacy/cli.py", symbol: "main" });
    expect(cli?.tests).toEqual([{ path: "tests/test_cli.py", command: "pytest" }]);
  });

  it("maps setup.py Python project names and console scripts", async () => {
    const root = await fixtureRoot("clawpatch-python-setup-py-entry-points-");
    await writeFixture(
      root,
      "setup.py",
      [
        "from setuptools import setup",
        "",
        "setup(",
        "    name='setup-cli',",
        "    entry_points={'console_scripts': ['setcli=setup_cli.cli:main']},",
        ")",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "setup_cli/cli.py", "def main():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const cli = result.features.find((feature) => feature.title === "Python CLI command setcli");

    expect(titles).toContain("Python project setup-cli");
    expect(cli?.entrypoints[0]).toMatchObject({ path: "setup_cli/cli.py", symbol: "main" });
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
