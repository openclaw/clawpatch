import { mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "./detect.js";
import { mapFeatures } from "./mapper.js";
import { discoverNodeProjects } from "./mappers/projects.js";
import { turboTaskGraph } from "./mappers/turbo.js";
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

  it("maps Next routes inside Nx workspace projects", async () => {
    const root = await fixtureRoot("clawpatch-map-next-nx-workspace-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(root, "yarn.lock", "");
    await writeFixture(
      root,
      "apps/web/package.json",
      JSON.stringify({ name: "web", scripts: { build: "next build" } }, null, 2),
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
      JSON.stringify({ name: "admin", scripts: { dev: "next dev" } }, null, 2),
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

  it("maps hoisted Next routes for workspace packages with Next scripts", async () => {
    const root = await fixtureRoot("clawpatch-map-next-hoisted-package-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/site/package.json",
      JSON.stringify({ name: "site", scripts: { dev: "next dev" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/site/src/pages/about.tsx",
      "export default function About() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.find((feature) => feature.title === "site route /about")?.entrypoints[0]
        ?.path,
    ).toBe("apps/site/src/pages/about.tsx");
  });

  it("does not treat package scripts without Next commands as hoisted Next projects", async () => {
    const root = await fixtureRoot("clawpatch-map-next-hoisted-script-helper-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/site/package.json",
      JSON.stringify({ name: "site", scripts: { sitemap: "next-sitemap" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/site/src/pages/about.tsx",
      "export default function About() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/site/src");
    expect(result.features.some((feature) => feature.title === "site route /about")).toBe(false);
  });

  it("maps Next routes inside Nx projects without package manifests", async () => {
    const root = await fixtureRoot("clawpatch-map-next-nx-no-package-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", dependencies: { next: "1.0.0" } }, null, 2),
    );
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

  it("does not treat project.json pages folders as hoisted Next projects", async () => {
    const root = await fixtureRoot("clawpatch-map-next-nx-pages-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/project.json",
      JSON.stringify({ name: "admin", sourceRoot: "apps/admin/src" }, null, 2),
    );
    await writeFixture(
      root,
      "apps/admin/src/pages/settings.tsx",
      "export default function Settings() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/admin/src");
    expect(result.features.some((feature) => feature.title === "admin route /settings")).toBe(
      false,
    );
  });

  it("maps generic package-less app roots and Next routes", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-monorepo-root-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", dependencies: { next: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/storefront/src/app/checkout/page.tsx",
      "export default function Checkout() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/storefront/src/app/checkout/page.test.tsx",
      "test('checkout', () => {});\n",
    );
    await writeFixture(root, "apps/worker/src/index.ts", "export const worker = true;\n");
    await writeFixture(root, "apps/worker/src/index.test.ts", "test('worker', () => {});\n");
    await writeFixture(root, "apps/api/server/index.ts", "export const api = true;\n");
    await writeFixture(root, "apps/api/server/index.test.ts", "test('api', () => {});\n");
    await writeFixture(
      root,
      "apps/admin/src/pages/About.tsx",
      "export default function About() { return null; }\n",
    );
    await writeFixture(
      root,
      "apps/pagesapp/src/pages/about.tsx",
      "export default function About() { return null; }\n",
    );
    await writeFixture(root, "apps/pagesapp/next.config.js", "module.exports = {};\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "storefront route /checkout");
    const worker = result.features.find(
      (feature) => feature.title === "Node source apps/worker/src",
    );
    const api = result.features.find((feature) => feature.title === "Node source apps/api/server");

    expect(route?.entrypoints[0]?.path).toBe("apps/storefront/src/app/checkout/page.tsx");
    expect(route?.tags).toEqual(
      expect.arrayContaining(["project:storefront", "project-root:apps/storefront"]),
    );
    expect(route?.tests).toContainEqual({
      path: "apps/storefront/src/app/checkout/page.test.tsx",
      command: null,
    });
    expect(worker?.ownedFiles).toContainEqual({
      path: "apps/worker/src/index.ts",
      reason: "source group apps/worker/src",
    });
    expect(worker?.tags).toEqual(
      expect.arrayContaining(["generic-project", "project:worker", "project-root:apps/worker"]),
    );
    expect(worker?.tests).toContainEqual({
      path: "apps/worker/src/index.test.ts",
      command: null,
    });
    expect(api?.ownedFiles).toContainEqual({
      path: "apps/api/server/index.ts",
      reason: "source group apps/api/server",
    });
    expect(api?.tests).toContainEqual({
      path: "apps/api/server/index.test.ts",
      command: null,
    });
    expect(result.features.some((feature) => feature.title === "admin route /About")).toBe(false);
    expect(
      result.features.find((feature) => feature.title === "pagesapp route /about")?.entrypoints[0]
        ?.path,
    ).toBe("apps/pagesapp/src/pages/about.tsx");
  });

  it("does not duplicate generic roots under package workspaces", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-nested-package-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/**"] }, null, 2),
    );
    await writeFixture(root, "apps/web/package.json", JSON.stringify({ name: "web" }, null, 2));
    await writeFixture(root, "apps/web/src/lib/foo.ts", "export const foo = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/web/src");
    expect(
      result.features.some((feature) => feature.tags.includes("project-root:apps/web/src")),
    ).toBe(false);
  });

  it("keeps recursive package-less project discovery to the shallowest root", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-recursive-root-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/**"] }, null, 2),
    );
    await writeFixture(root, "apps/web/src/app/page.tsx", "export default function Page() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/web/src");
    expect(
      result.features.some((feature) => feature.tags.includes("project-root:apps/web/src")),
    ).toBe(false);
  });

  it("does not treat recursive workspace containers as package-less projects", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-recursive-container-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/**"] }, null, 2),
    );
    await writeFixture(root, "apps/api/server/index.ts", "export const api = true;\n");
    await writeFixture(root, "apps/web/src/index.ts", "export const web = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Node source apps/api/server");
    expect(titles).toContain("Node source apps/web/src");
    expect(result.features.some((feature) => feature.tags.includes("project-root:apps"))).toBe(
      false,
    );
  });

  it("maps package-less projects under bare recursive workspace globs", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-bare-recursive-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["**"] }, null, 2),
    );
    await writeFixture(root, "services/api/src/index.ts", "export const api = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find(
      (feature) => feature.title === "Node source services/api/src",
    );

    expect(source?.ownedFiles).toContainEqual({
      path: "services/api/src/index.ts",
      reason: "source group services/api/src",
    });
    expect(source?.tags).toEqual(
      expect.arrayContaining(["project:api", "project-root:services/api"]),
    );
    expect(result.features.some((feature) => feature.tags.includes("project-root:services"))).toBe(
      false,
    );
  });

  it("maps API-only package-less Next apps", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-next-api-only-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/app-api/app/api/hello/route.ts",
      "export function GET() { return new Response('ok'); }\n",
    );
    await writeFixture(
      root,
      "apps/pages-api/pages/api/hello.ts",
      "export default function handler() {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.find((feature) => feature.title === "app-api route /api/hello")
        ?.entrypoints[0]?.path,
    ).toBe("apps/app-api/app/api/hello/route.ts");
    expect(
      result.features.find((feature) => feature.title === "pages-api route /api/hello")
        ?.entrypoints[0]?.path,
    ).toBe("apps/pages-api/pages/api/hello.ts");
  });

  it("maps package-less apps with nested server API sources", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-server-api-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(root, "apps/foo/server/api/index.ts", "export const api = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find(
      (feature) => feature.title === "Node source apps/foo/server",
    );

    expect(source?.ownedFiles).toContainEqual({
      path: "apps/foo/server/api/index.ts",
      reason: "source group apps/foo/server",
    });
    expect(source?.tags).toEqual(expect.arrayContaining(["project:foo", "project-root:apps/foo"]));
  });

  it("does not let docs-only src folders suppress nested package-less projects", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-docs-only-src-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/**"] }, null, 2),
    );
    await writeFixture(root, "apps/foo/src/README.md", "# notes\n");
    await writeFixture(root, "apps/foo/src/tsconfig.json", "{}\n");
    await writeFixture(root, "apps/foo/bar/src/index.ts", "export const bar = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find(
      (feature) => feature.title === "Node source apps/foo/bar/src",
    );

    expect(source?.ownedFiles).toContainEqual({
      path: "apps/foo/bar/src/index.ts",
      reason: "source group apps/foo/bar/src",
    });
    expect(source?.tags).toEqual(
      expect.arrayContaining(["project:bar", "project-root:apps/foo/bar"]),
    );
    expect(result.features.some((feature) => feature.tags.includes("project-root:apps/foo"))).toBe(
      false,
    );
  });

  it("does not let non-reviewable src files suppress nested package-less projects", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-non-reviewable-src-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/**"] }, null, 2),
    );
    await writeFixture(root, "apps/foo/src/types.d.ts", "export type Config = {};\n");
    await writeFixture(root, "apps/foo/src/index.test.ts", "test('container', () => {});\n");
    await writeFixture(
      root,
      "apps/foo/src/generated/client.ts",
      "export const generated = true;\n",
    );
    await writeFixture(root, "apps/foo/src/fixtures/example.ts", "export const fixture = true;\n");
    await writeFixture(root, "apps/foo/bar/src/index.ts", "export const bar = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find(
      (feature) => feature.title === "Node source apps/foo/bar/src",
    );

    expect(source?.ownedFiles).toContainEqual({
      path: "apps/foo/bar/src/index.ts",
      reason: "source group apps/foo/bar/src",
    });
    expect(source?.tags).toEqual(
      expect.arrayContaining(["project:bar", "project-root:apps/foo/bar"]),
    );
    expect(result.features.some((feature) => feature.tags.includes("project-root:apps/foo"))).toBe(
      false,
    );
  });

  it("does not treat package-less React pages as Next routes without a Next signal", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-react-pages-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", dependencies: { react: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/src/pages/About.tsx",
      "export default function About() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).toContain("Node source apps/web/src");
    expect(result.features.some((feature) => feature.source === "next-pages-route")).toBe(false);
  });

  it("normalizes leading dot workspace globs for package-less Next apps", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-dot-workspace-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["./services/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "services/web/src/app/about/page.tsx",
      "export default function About() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "web route /about");
    const source = result.features.find(
      (feature) => feature.title === "Node source services/web/src",
    );

    expect(route?.entrypoints[0]?.path).toBe("services/web/src/app/about/page.tsx");
    expect(route?.tags).toEqual(
      expect.arrayContaining(["project:web", "project-root:services/web"]),
    );
    expect(source?.tags).toEqual(
      expect.arrayContaining(["project:web", "project-root:services/web"]),
    );
    expect(
      result.features.some((feature) => feature.tags.includes("project-root:./services/web")),
    ).toBe(false);
  });

  it("maps deep package-less Next route trees", async () => {
    const root = await fixtureRoot("clawpatch-map-generic-deep-next-route-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "workspace-root", workspaces: ["apps/*"], dependencies: { next: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/web/src/app/(shop)/products/[slug]/reviews/page.tsx",
      "export default function Reviews() { return null; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find(
      (feature) => feature.title === "web route /products/:slug/reviews",
    );

    expect(route?.entrypoints[0]?.path).toBe(
      "apps/web/src/app/(shop)/products/[slug]/reviews/page.tsx",
    );
    expect(route?.tags).toEqual(expect.arrayContaining(["project:web", "project-root:apps/web"]));
  });

  it("does not duplicate nested Node source roots under project sourceRoot", async () => {
    const root = await fixtureRoot("clawpatch-map-source-root-overlap-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "workspace-root", workspaces: ["apps/*"] }, null, 2),
    );
    await writeFixture(
      root,
      "apps/web/project.json",
      JSON.stringify({ name: "web", sourceRoot: "apps/web", targets: {} }, null, 2),
    );
    await writeFixture(root, "apps/web/src/index.ts", "export const web = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const sourceFeatures = result.features.filter((feature) =>
      feature.title.startsWith("Node source apps/web"),
    );

    expect(sourceFeatures.map((feature) => feature.title)).toEqual(["Node source apps/web"]);
    expect(sourceFeatures[0]?.ownedFiles).toContainEqual({
      path: "apps/web/src/index.ts",
      reason: "source group apps/web",
    });
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

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "React route /home");

    expect(route?.tests).toEqual([
      { path: "apps/web/src/pages/HomePage.test.tsx", command: "pnpm turbo run test --filter web" },
    ]);
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

  it("detects RuboCop extension gems as Ruby lint providers", async () => {
    const root = await fixtureRoot("clawpatch-map-rubocop-extension-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\ngem 'rubocop-rails'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");

    const project = await detectProject(root);

    expect(project.detected.commands.lint).toBe("bundle exec rubocop");
  });

  it("does not treat Ruby test helpers as Minitest tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-test-helper-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/test_helper.rb", "module TestHelper\nend\n");
    await writeFixture(root, "lib/test_utils.rb", "module TestUtils\nend\n");
    await writeFixture(root, "test/test_helper.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const owned = result.features.flatMap((feature) => feature.ownedFiles.map((ref) => ref.path));

    expect(project.detected.commands.test).toBeNull();
    expect(result.features.map((feature) => feature.title)).not.toContain("Ruby test suite test");
    expect(owned).toContain("lib/test_helper.rb");
    expect(owned).toContain("lib/test_utils.rb");
    expect(owned).not.toContain("test/test_helper.rb");
  });

  it("detects co-located Ruby Minitest suffix tests", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-colocated-minitest-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "lib/fixture_test.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Ruby source lib");

    expect(project.detected.commands.test).toBe("bundle exec rake test");
    expect(source?.tests).toEqual([
      { path: "lib/fixture_test.rb", command: "bundle exec rake test" },
    ]);
  });

  it("keeps test-prefixed Ruby sources under lib reviewable", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-test-prefixed-source-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "lib/test_client.rb", "module TestClient\nend\n");
    await writeFixture(root, "test/test_client_test.rb", "require 'minitest/autorun'\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "Ruby source lib");

    expect(project.detected.languages).toContain("ruby");
    expect(source?.ownedFiles.map((ref) => ref.path)).toContain("lib/test_client.rb");
    expect(source?.tests).toEqual([
      { path: "test/test_client_test.rb", command: "bundle exec rake test" },
    ]);
  });

  it("maps scripts directory Ruby files as source only", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-scripts-source-");
    await writeFixture(root, "Gemfile", "source 'https://rubygems.org'\n");
    await writeFixture(root, "scripts/support.rb", "module Support\nend\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Ruby source scripts");
    expect(titles).not.toContain("Ruby CLI command support.rb");
  });

  it("ignores generated nested gemspec artifacts", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-generated-gemspec-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "node-only" }));
    await writeFixture(
      root,
      "dist/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'built-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "tmp/runtime.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'tmp-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "log/runtime.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'log-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      "target/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'target-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(
      root,
      ".build/generated.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'build-artifact'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.languages).not.toContain("ruby");
    expect(project.detected.frameworks).not.toContain("rails");
    expect(titles).not.toContain("Ruby project built-artifact");
    expect(titles).not.toContain("Ruby project tmp-artifact");
    expect(titles).not.toContain("Ruby project log-artifact");
    expect(titles).not.toContain("Ruby project target-artifact");
    expect(titles).not.toContain("Ruby project build-artifact");
    expect(nodeAsset?.title).toBe("Node source app");
  });

  it("ignores gemspec directories during Ruby dependency scans", async () => {
    const root = await fixtureRoot("clawpatch-map-ruby-gemspec-dir-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "gemspec-dir" }));
    await mkdir(join(root, "fake.gemspec"));
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.frameworks).not.toContain("rails");
    expect(nodeAsset?.title).toBe("Node source app");
  });

  it("does not apply nested Ruby gemspec dependencies to root Rails detection", async () => {
    const root = await fixtureRoot("clawpatch-map-nested-ruby-gemspec-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "mixed-root" }));
    await writeFixture(
      root,
      "engine/engine.gemspec",
      "Gem::Specification.new do |spec|\n  spec.name = 'engine'\n  spec.add_dependency 'rails'\nend\n",
    );
    await writeFixture(root, "engine/lib/engine.rb", "module Engine\nend\n");
    await writeFixture(root, "engine/test/test_engine.rb", "require 'minitest/autorun'\n");
    await writeFixture(root, "config/application.rb", "module NotRails\nend\n");
    await writeFixture(root, "app/assets/admin.ts", "export const admin = true;\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const rubySource = result.features.find(
      (feature) => feature.title === "Ruby source engine/lib",
    );
    const nodeAsset = result.features.find((feature) =>
      feature.ownedFiles.some((file) => file.path === "app/assets/admin.ts"),
    );

    expect(project.detected.languages).toContain("ruby");
    expect(project.detected.frameworks).not.toContain("rails");
    expect(project.detected.commands.test).toBe("rake test");
    expect(titles).not.toContain("Rails application configuration");
    expect(titles).toContain("Ruby test suite engine/test");
    expect(rubySource?.tests).toEqual([
      { path: "engine/test/test_engine.rb", command: "rake test" },
    ]);
    expect(nodeAsset?.title).toBe("Node source app");
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
    await writeFixture(root, "config/database.yml", "production:\n  password: secret\n");
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
    for (let index = 0; index < 14; index += 1) {
      await writeFixture(
        root,
        `config/initializers/initializer_${String(index).padStart(2, "0")}.rb`,
        "Rails.application.configure {}\n",
      );
    }
    await writeFixture(
      root,
      "config/initializers/secret_token.rb",
      "Rails.application.config.secret_token = 'secret'\n",
    );
    await writeFixture(root, "db/schema.rb", "ActiveRecord::Schema.define do\nend\n");
    await writeFixture(root, "db/structure.sql", "CREATE TABLE widgets (id bigint);\n");
    await writeFixture(
      root,
      "db/migrate/20200101000000_create_widgets.rb",
      "class CreateWidgets < ActiveRecord::Migration[6.1]\nend\n",
    );
    for (let index = 1; index < 14; index += 1) {
      await writeFixture(
        root,
        `db/migrate/202001010000${String(index).padStart(2, "0")}_create_widgets_${index}.rb`,
        "class CreateWidgets < ActiveRecord::Migration[6.1]\nend\n",
      );
    }
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
    await writeFixture(root, "app/assets/javascripts/admin.tsx", "export function Admin() {}\n");
    await writeFixture(root, "app/assets/builds/application.js", "console.log('built');\n");
    await writeFixture(root, "app/assets/stylesheets/widgets.scss", ".widgets { color: black; }\n");
    await writeFixture(
      root,
      "app/javascript/controllers/widgets_controller.js",
      "export function connect() {}\n",
    );
    await writeFixture(
      root,
      "app/javascript/stylesheets/application.scss",
      ".widgets { display: grid; }\n",
    );
    await writeFixture(
      root,
      "app/components/widget_component.ts",
      "export function wireWidgetComponent() {}\n",
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
    const nodePackage = result.features.find(
      (feature) => feature.title === "Node package rails-webpacker-shell",
    );
    const railsConfig = result.features.find(
      (feature) => feature.title === "Rails application configuration",
    );
    const railsDatabaseFeatures = result.features.filter(
      (feature) => feature.source === "rails-database",
    );
    const railsAssetRefs = result.features
      .filter((feature) => feature.source === "rails-assets")
      .flatMap((feature) => feature.ownedFiles.map((ref) => ref.path));

    expect(project.detected.frameworks).toContain("rails");
    expect(titles).not.toContain("Ruby CLI command rails");
    expect(titles).not.toContain("Node source app/assets");
    expect(titles).toContain("Node source app");
    expect(titles).toContain("Node source app/javascript");
    expect(titles).toContain("Node source src");
    expect(titles).toContain("Node source lib");
    expect(titles).toContain("Node source pages");
    expect(titles).toContain("Rails application configuration");
    expect(titles).toContain("Rails database schema and migrations");
    expect(titles).toContain("Rails database schema and migrations db/migrate#2");
    expect(titles).toContain("Rails views app/views");
    expect(titles).toContain("Rails assets app/assets");
    expect(railsDatabaseFeatures.every((feature) => feature.ownedFiles.length <= 12)).toBe(true);
    expect(referencedFiles).toContain("db/structure.sql");
    expect(referencedFiles).toContain("app/components/widget_component.ts");
    expect(railsAssetRefs).toContain("app/assets/javascripts/admin.tsx");
    expect(railsAssetRefs).toContain("app/javascript/stylesheets/application.scss");
    expect(railsAssetRefs).not.toContain("app/javascript/controllers/widgets_controller.js");
    expect(railsAssetRefs).not.toContain("app/assets/builds/application.js");
    expect(nodePackage?.contextFiles).toContainEqual({
      path: "app/javascript/controllers/widgets_controller.js",
      reason: "package source overview",
    });
    expect(rubyProject?.trustBoundaries).toEqual(
      expect.arrayContaining(["database", "network", "serialization"]),
    );
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).toContain("config/routes.rb");
    expect(railsConfig?.ownedFiles.slice(0, 12).map((ref) => ref.path)).toContain(
      "config/routes.rb",
    );
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain("config/secrets.yml");
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain("config/database.yml");
    expect(railsConfig?.ownedFiles.map((ref) => ref.path)).not.toContain(
      "config/initializers/secret_token.rb",
    );
    expect(
      result.features.filter((feature) =>
        feature.ownedFiles.some(
          (ref) => ref.path === "app/javascript/controllers/widgets_controller.js",
        ),
      ),
    ).toHaveLength(1);
    expect(referencedFiles).not.toContain("config/database.yml");
    expect(referencedFiles).not.toContain("config/secrets.yml");
    expect(referencedFiles).not.toContain("config/initializers/secret_token.rb");
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

  it("maps Express, Fastify, and Hono string-literal routes", async () => {
    const root = await fixtureRoot("clawpatch-node-server-routes-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "server-app",
          scripts: { test: "vitest run" },
          dependencies: { express: "1.0.0", fastify: "1.0.0", hono: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/server.ts",
      [
        "// route imports",
        "import { Router as OtherRouter } from 'other-router';",
        "/* import { Router as CommentedOutRouter } from 'express'; */",
        "/* import banner */ import { Router as BannerRouter } from 'express';",
        "/*",
        " * multiline import banner",
        " */ import { Router as MultilineBannerRouter } from 'express';",
        "import unused from 'unused'; /* stacked */ /* import banner */ import { Router as SemicolonBannerRouter } from 'express';",
        "import from, { Router as FromBindingRouter } from 'express';",
        "import 'reflect-metadata'",
        "import/* type banner */type { Router as CommentedTypeRouter } from 'express';",
        "import express, { Router, Router as ExpressRouter } from 'express';",
        "",
        "const config = { import: true }",
        "export type { Router as ExportedTypeRouter } from 'express';",
        "const importPattern = /import { Router as RegexImportRouter } from 'express'/;",
        "const app = express();",
        "const otherRouter = OtherRouter();",
        "const commentedOutRouter = CommentedOutRouter();",
        "const router = Router();",
        "const aliasRouter = ExpressRouter();",
        "const bannerRouter = BannerRouter();",
        "const multilineBannerRouter = MultilineBannerRouter();",
        "const semicolonBannerRouter = SemicolonBannerRouter();",
        "const fromBindingRouter = FromBindingRouter();",
        "const commentedTypeRouter = CommentedTypeRouter();",
        "const exportedTypeRouter = ExportedTypeRouter();",
        "const regexImportRouter = RegexImportRouter();",
        "const typedRouter: Router = Router();",
        "const projectRouter = Router({ mergeParams: true });",
        "let hitCount = 0;",
        "const normalized = hitCount++ / 100;",
        "app.get('/health', health);",
        "app.get('/after-postfix-division', afterPostfixDivision);",
        "app.get('/admin', requireAuth, showAdmin);",
        "app.get('/anonymous', requireAuth, (_req, res) => res.send('ok'));",
        "app.get('/dynamic/' + version, dynamicRoute);",
        "app.all('/proxy', proxy);",
        "otherRouter.get('/other-router', ignoredOtherRouter);",
        "commentedOutRouter.get('/commented-out-router', ignoredCommentedOutRouter);",
        "router.post('/admin/jobs', createJob);",
        "aliasRouter.get('/aliased-router', listAliasedRouter);",
        "bannerRouter.get('/banner-router', listBannerRouter);",
        "multilineBannerRouter.get('/multiline-banner-router', listMultilineBannerRouter);",
        "semicolonBannerRouter.get('/semicolon-banner-router', listSemicolonBannerRouter);",
        "fromBindingRouter.get('/from-binding-router', listFromBindingRouter);",
        "commentedTypeRouter.get('/commented-type-router', ignoredCommentedTypeRouter);",
        "exportedTypeRouter.get('/exported-type-router', ignoredExportedTypeRouter);",
        "regexImportRouter.get('/regex-import-router', ignoredRegexImportRouter);",
        "router.post<{ Body: CreateJob }>('/typed-jobs', createTypedJob);",
        "typedRouter.patch('/typed/:id', updateTyped);",
        "router.route('/users').get(listUsers).delete(deleteUsers);",
        "router.route('/reports').get(listReports);",
        "projectRouter.get('/projects/:projectId/items', listProjectItems);",
        "const routePattern = /app.get('\\/regex-health')/;",
        "const returnedPattern = () => /app.get('\\/arrow-regex')/;",
        "db.delete('/not-a-route');",
        "// app.get('/commented', ignored);",
        "const text = \"router.post('/string', ignored)\";",
        "function routePatternFn() { return /app.get('\\/returned-regex')/; }",
        "function health() {}",
        "function afterPostfixDivision() {}",
        "function requireAuth() {}",
        "function showAdmin() {}",
        "function dynamicRoute() {}",
        "function proxy() {}",
        "function ignoredOtherRouter() {}",
        "function ignoredCommentedOutRouter() {}",
        "function createJob() {}",
        "function listAliasedRouter() {}",
        "function listBannerRouter() {}",
        "function listMultilineBannerRouter() {}",
        "function listSemicolonBannerRouter() {}",
        "function listFromBindingRouter() {}",
        "function ignoredCommentedTypeRouter() {}",
        "function ignoredExportedTypeRouter() {}",
        "function ignoredRegexImportRouter() {}",
        "function createTypedJob() {}",
        "function updateTyped() {}",
        "function listUsers() {}",
        "function deleteUsers() {}",
        "function listReports() {}",
        "function listProjectItems() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/fastify.ts",
      [
        "import Fastify from 'fastify';",
        "",
        "const fastify = Fastify<{ logger: true }>();",
        "fastify.get('/status', status);",
        "fastify.get<{ Params: { id: string } }>('/typed-users/:id', showTypedUser);",
        "fastify.route({ method: 'GET', url: '/route-status', handler: routeStatus });",
        "fastify.route({ method: 'GET', url: `/dynamic/${id}`, handler: dynamicRoute });",
        "fastify.route({ method: 'GET', url: '/concat-' + suffix, handler: dynamicRoute });",
        "fastify.post('/webhook/github', handleWebhook);",
        "function status() {}",
        "function showTypedUser() {}",
        "function routeStatus() {}",
        "function dynamicRoute() {}",
        "function handleWebhook() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/fastify-plugin.ts",
      [
        "import fastifyPlugin from 'fastify-plugin';",
        "import fp from 'fastify-plugin';",
        "import cjsPlugin = require('fastify-plugin');",
        "import { FastifyInstance } from 'fastify';",
        "import type { FastifyInstance as FastifyApp } from 'fastify';",
        "",
        "export async function routes(fastify: FastifyInstance) {",
        "  fastify.get('/plugin-users', listPluginUsers);",
        "}",
        "export async function appRoutes(app: FastifyInstance) {",
        "  app.get('/plugin-app-users', listPluginAppUsers);",
        "}",
        "export async function typedReturnRoutes(app: FastifyInstance): Promise<void> {",
        "  app.get('/plugin-typed-return-users', listPluginTypedReturnUsers);",
        "}",
        "export async function typedObjectReturnRoutes(app: FastifyInstance): Promise<{ ok: true }> {",
        "  app.get('/plugin-typed-object-return-users', listPluginTypedObjectReturnUsers);",
        "}",
        "export async function aliasedTypeRoutes(app: FastifyApp) {",
        "  app.get('/plugin-aliased-type-users', listPluginAliasedTypeUsers);",
        "}",
        "const app = createHttpServer();",
        "app.get('/not-plugin-app-typed', ignoredApp);",
        "export const serverRoutes = fastifyPlugin(async function routes(server) {",
        "  server.get('/plugin-server-users', listPluginServerUsers);",
        "});",
        "export const serverReturnRoutes = fastifyPlugin(function routes(server): Promise<void> {",
        "  server.get('/plugin-server-return-users', listPluginServerReturnUsers);",
        "});",
        "export const arrowRoutes = fastifyPlugin(async (app) => {",
        "  app.get('/plugin-arrow-users', listPluginArrowUsers);",
        "});",
        "export const bareArrowRoutes = fastifyPlugin(async bareApp => {",
        "  bareApp.get('/plugin-bare-arrow-users', listPluginBareArrowUsers);",
        "});",
        "export const instanceRoutes = fp(async (instance, options) => {",
        "  instance.get('/plugin-instance-users', listPluginInstanceUsers);",
        "  options.get('/not-plugin-options', ignoredOptions);",
        "});",
        "export const commentRoutes = fp(async (instance) => {",
        "  // }",
        "  instance.get('/plugin-comment-users', listPluginCommentUsers);",
        "});",
        "export const commentedArgumentRoutes = fp( /* routes */ async (commentedApp) => {",
        "  commentedApp.get('/plugin-commented-argument-users', listPluginCommentedArgumentUsers);",
        "});",
        "export const aliasedRoutes = fp(async (app) => {",
        "  app.get('/plugin-aliased-users', listPluginAliasedUsers);",
        "});",
        "type PluginOptions = { prefix: string };",
        "export const genericRoutes = fastifyPlugin<PluginOptions>(async (server) => {",
        "  server.get('/plugin-generic-users', listPluginGenericUsers);",
        "});",
        "export const importEqualsRoutes = cjsPlugin(async (server) => {",
        "  server.get('/plugin-import-equals-users', listPluginImportEqualsUsers);",
        "});",
        "const defaultPlugin = require('fastify-plugin').default;",
        "export const defaultRequireRoutes = defaultPlugin(async (app) => {",
        "  app.get('/plugin-default-require-users', listPluginDefaultRequireUsers);",
        "});",
        "export const typedArrowRoutes = async (server: FastifyInstance): Promise<void> => {",
        "  server.get('/plugin-typed-arrow-users', listPluginTypedArrowUsers);",
        "};",
        "const server = createHttpServer();",
        "server.get('/not-plugin-server', ignoredServer);",
        'export async function inlineRoutes(inlineApp: import("fastify").FastifyInstance) {',
        '  inlineApp.get("/plugin-inline-users", listPluginInlineUsers);',
        "}",
        'export const inlineArrowRoutes = async (inlineServer: import("fastify").FastifyInstance): Promise<void> => {',
        '  inlineServer.get("/plugin-inline-arrow-users", listPluginInlineArrowUsers);',
        "};",
        "function listPluginUsers() {}",
        "function listPluginAppUsers() {}",
        "function listPluginTypedReturnUsers() {}",
        "function listPluginTypedObjectReturnUsers() {}",
        "function listPluginAliasedTypeUsers() {}",
        "function listPluginServerUsers() {}",
        "function listPluginServerReturnUsers() {}",
        "function listPluginArrowUsers() {}",
        "function listPluginBareArrowUsers() {}",
        "function listPluginInstanceUsers() {}",
        "function listPluginCommentUsers() {}",
        "function listPluginCommentedArgumentUsers() {}",
        "function listPluginAliasedUsers() {}",
        "function listPluginGenericUsers() {}",
        "function listPluginImportEqualsUsers() {}",
        "function listPluginDefaultRequireUsers() {}",
        "function listPluginTypedArrowUsers() {}",
        "function listPluginInlineUsers() {}",
        "function listPluginInlineArrowUsers() {}",
        "function createHttpServer() { return { get() {} }; }",
        "function ignoredApp() {}",
        "function ignoredServer() {}",
        "function ignoredOptions() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/fastify-multiline-import.ts",
      [
        "import {",
        "  FastifyInstance,",
        "} from 'fastify';",
        "",
        "export async function multilineRoutes(app: FastifyInstance) {",
        "  app.get('/plugin-multiline-users', listPluginMultilineUsers);",
        "}",
        "function listPluginMultilineUsers() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/not-fastify-plugin.ts",
      [
        'import { FastifyInstance } from "./types"',
        'import Fastify from "fastify"',
        "export async function genericAppRoutes(app) {",
        '  app.get("/not-plugin-app", ignored);',
        "}",
        "export async function shadowInstanceRoutes(instance: FastifyInstance) {",
        '  instance.get("/shadow-fastify-instance", ignored);',
        "}",
        "function ignored() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/cjs-router.cjs",
      [
        "const { Router: CjsRouter, json: JsonFactory } = require('express');",
        "",
        "const cjsRouter = CjsRouter();",
        "cjsRouter.get('/cjs-aliased-router', listCjsAliasedRouter);",
        "const jsonFactory = JsonFactory();",
        "jsonFactory.get('/cjs-not-router', ignored);",
        "function listCjsAliasedRouter() {}",
        "function ignored() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/router-assignment.ts",
      [
        "import express from 'express';",
        "",
        "const AssignedRouter = express.Router;",
        "const TypedAssignedRouter: typeof express.Router = express.Router;",
        "const RequiredRouter = require('express').Router;",
        "const NotRouter = express.json;",
        "const assignedRouter = AssignedRouter();",
        "const typedAssignedRouter = TypedAssignedRouter();",
        "const requiredRouter = RequiredRouter();",
        "const notRouter = NotRouter();",
        "assignedRouter.get('/assigned-router', listAssignedRouter);",
        "typedAssignedRouter.get('/typed-assigned-router', listTypedAssignedRouter);",
        "requiredRouter.get('/required-router', listRequiredRouter);",
        "notRouter.get('/assigned-not-router', ignored);",
        "function listAssignedRouter() {}",
        "function listTypedAssignedRouter() {}",
        "function listRequiredRouter() {}",
        "function ignored() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/hono.ts",
      [
        "import { Hono } from 'hono';",
        "",
        "const app = new Hono<{ Bindings: Env }>();",
        "app.get('/api/items', listItems);",
        "app.delete('/sessions/:id', deleteSession);",
        "function listItems() {}",
        "function deleteSession() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "src/server.test.ts", "test('server', () => {});\n");
    await writeFixture(root, "src/fastify.test.ts", "test('fastify', () => {});\n");
    await writeFixture(root, "src/fastify-plugin.test.ts", "test('fastify plugin', () => {});\n");
    await writeFixture(root, "src/hono.test.ts", "test('hono', () => {});\n");
    await writeFixture(
      root,
      "src/bom-router.ts",
      [
        "\uFEFFimport { Router as BomRouter } from 'express';",
        "",
        "const bomRouter = BomRouter();",
        "bomRouter.get('/bom-router', listBomRouter);",
        "function listBomRouter() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/mixed.tsx",
      [
        "import express from 'express';",
        "",
        "const app = express();",
        "const view = <div></div>;",
        "const docs = <code>import { Router as JsxImportRouter } from 'express'</code>;",
        "const jsxImportRouter = JsxImportRouter();",
        "app.get('/after-jsx-close', afterJsxClose);",
        "jsxImportRouter.get('/jsx-import-router', ignoredJsxImportRouter);",
        "function afterJsxClose() {}",
        "function ignoredJsxImportRouter() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/custom-router.ts",
      [
        "// import { Router } from 'express';",
        "import { Router as CustomRouter } from './custom-router-factory';",
        "import express from 'express';",
        "import { type Router, type Router as ExpressRouter } from 'express';",
        "",
        "declare function Router(): { get(path: string, handler: unknown): void };",
        "declare function ExpressRouter(): { get(path: string, handler: unknown): void };",
        "",
        "const app = express();",
        "const customRouter = CustomRouter();",
        "const router = Router();",
        "const aliasRouter = ExpressRouter();",
        "app.get('/custom-file-real', handler);",
        "customRouter.get('/custom-import-router', handler);",
        "router.get('/custom-router', handler);",
        "aliasRouter.get('/custom-alias-router', handler);",
        "function handler() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const admin = result.features.find(
      (feature) => feature.title === "Express route POST /admin/jobs",
    );
    const webhook = result.features.find(
      (feature) => feature.title === "Fastify route POST /webhook/github",
    );
    const adminMiddleware = result.features.find(
      (feature) => feature.title === "Express route GET /admin",
    );
    const anonymousHandler = result.features.find(
      (feature) => feature.title === "Express route GET /anonymous",
    );
    const fastifyRouteObject = result.features.find(
      (feature) => feature.title === "Fastify route GET /route-status",
    );
    const session = result.features.find(
      (feature) => feature.title === "Hono route DELETE /sessions/:id",
    );

    expect(project.detected.frameworks).toEqual(
      expect.arrayContaining(["express", "fastify", "hono"]),
    );
    expect(titles).toEqual(
      expect.arrayContaining([
        "Express route GET /health",
        "Express route GET /after-postfix-division",
        "Express route GET /admin",
        "Express route GET /anonymous",
        "Express route ALL /proxy",
        "Express route POST /admin/jobs",
        "Express route GET /aliased-router",
        "Express route GET /banner-router",
        "Express route GET /multiline-banner-router",
        "Express route GET /semicolon-banner-router",
        "Express route GET /from-binding-router",
        "Express route GET /cjs-aliased-router",
        "Express route GET /assigned-router",
        "Express route GET /typed-assigned-router",
        "Express route GET /required-router",
        "Express route POST /typed-jobs",
        "Express route PATCH /typed/:id",
        "Express route GET /users",
        "Express route DELETE /users",
        "Express route GET /reports",
        "Express route GET /projects/:projectId/items",
        "Express route GET /bom-router",
        "Express route GET /after-jsx-close",
        "Express route GET /custom-file-real",
        "Fastify route GET /status",
        "Fastify route GET /typed-users/:id",
        "Fastify route GET /route-status",
        "Fastify route POST /webhook/github",
        "Fastify route GET /plugin-users",
        "Fastify route GET /plugin-app-users",
        "Fastify route GET /plugin-typed-return-users",
        "Fastify route GET /plugin-typed-object-return-users",
        "Fastify route GET /plugin-aliased-type-users",
        "Fastify route GET /plugin-server-users",
        "Fastify route GET /plugin-server-return-users",
        "Fastify route GET /plugin-arrow-users",
        "Fastify route GET /plugin-bare-arrow-users",
        "Fastify route GET /plugin-instance-users",
        "Fastify route GET /plugin-comment-users",
        "Fastify route GET /plugin-commented-argument-users",
        "Fastify route GET /plugin-aliased-users",
        "Fastify route GET /plugin-generic-users",
        "Fastify route GET /plugin-import-equals-users",
        "Fastify route GET /plugin-default-require-users",
        "Fastify route GET /plugin-typed-arrow-users",
        "Fastify route GET /plugin-inline-users",
        "Fastify route GET /plugin-inline-arrow-users",
        "Fastify route GET /plugin-multiline-users",
        "Hono route GET /api/items",
        "Hono route DELETE /sessions/:id",
      ]),
    );
    expect(titles).not.toContain("Express route GET /commented");
    expect(titles).not.toContain("Express route POST /string");
    expect(titles).not.toContain("Express route GET /regex-health");
    expect(titles).not.toContain("Express route GET /arrow-regex");
    expect(titles).not.toContain("Express route GET /returned-regex");
    expect(titles).not.toContain("Express route GET /other-router");
    expect(titles).not.toContain("Express route GET /commented-out-router");
    expect(titles).not.toContain("Express route GET /commented-type-router");
    expect(titles).not.toContain("Express route GET /exported-type-router");
    expect(titles).not.toContain("Express route GET /regex-import-router");
    expect(titles).not.toContain("Express route GET /jsx-import-router");
    expect(titles).not.toContain("Express route GET /custom-import-router");
    expect(titles).not.toContain("Express route GET /custom-router");
    expect(titles).not.toContain("Express route GET /custom-alias-router");
    expect(titles).not.toContain("Express route GET /cjs-not-router");
    expect(titles).not.toContain("Express route GET /assigned-not-router");
    expect(titles).not.toContain("Express route GET /dynamic/");
    expect(titles).not.toContain("Fastify route GET /dynamic/");
    expect(titles).not.toContain("Fastify route GET /not-plugin-app");
    expect(titles).not.toContain("Fastify route GET /not-plugin-app-typed");
    expect(titles).not.toContain("Fastify route GET /not-plugin-server");
    expect(titles).not.toContain("Fastify route GET /not-plugin-options");
    expect(titles).not.toContain("Fastify route GET /shadow-fastify-instance");
    expect(titles).not.toContain("Fastify route GET /concat-");
    expect(titles).not.toContain("Express route DELETE /reports");
    expect(admin?.source).toBe("express-route");
    expect(admin?.entrypoints[0]).toMatchObject({
      path: "src/server.ts",
      symbol: "createJob",
      route: "POST /admin/jobs",
    });
    expect(admin?.tests).toEqual([{ path: "src/server.test.ts", command: "npm run test" }]);
    expect(admin?.trustBoundaries).toContain("auth");
    expect(webhook?.trustBoundaries).toEqual(expect.arrayContaining(["auth", "external-api"]));
    expect(adminMiddleware?.entrypoints[0]?.symbol).toBe("showAdmin");
    expect(anonymousHandler?.entrypoints[0]?.symbol).toBeNull();
    expect(fastifyRouteObject?.entrypoints[0]?.symbol).toBe("routeStatus");
    expect(session?.trustBoundaries).toContain("auth");
  });

  it("maps Fastify route-object static method arrays conservatively", async () => {
    const root = await fixtureRoot("clawpatch-fastify-method-array-routes-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "fastify-array-routes",
          dependencies: { fastify: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/fastify.ts",
      [
        "import Fastify from 'fastify';",
        "",
        "const fastify = Fastify();",
        "fastify.route({ method: ['GET', 'POST'], url: '/items', handler: items });",
        "fastify.route({ method: ['DELETE', configuredMethod], url: '/mixed', handler: mixed });",
        "fastify.route({ method: ['GET', configuredMethods[0]], url: '/indexed-mixed', handler: indexedMixed });",
        "fastify.route({ method: ['PUT', 'PATCH'] as const, url: '/const-items', handler: constItems });",
        "fastify.route({ method: ['OPTIONS'] satisfies readonly string[], url: '/satisfies-items', handler: satisfiesItems });",
        "fastify.route({ method: [configuredMethod], url: '/dynamic-only', handler: dynamicOnly });",
        "fastify.route({ method: [200], url: '/numeric-only', handler: numericOnly });",
        "fastify.route({ method: [`PATCH`], url: '/template-static', handler: templateStatic });",
        "fastify.route({ method: ['GET', `POST-${suffix}`], url: '/template-mixed', handler: templateMixed });",
        "fastify.route({ method: [`PUT-${suffix}`, 'HEAD'], url: '/template-mixed-tail', handler: templateMixedTail });",
        "fastify.route({ method: [`PATCH-${suffix}`], url: '/template-dynamic', handler: templateDynamic });",
        "function items() {}",
        "function mixed() {}",
        "function indexedMixed() {}",
        "function constItems() {}",
        "function satisfiesItems() {}",
        "function dynamicOnly() {}",
        "function numericOnly() {}",
        "function templateStatic() {}",
        "function templateMixed() {}",
        "function templateMixedTail() {}",
        "function templateDynamic() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const routes = result.features
      .map((feature) => feature.entrypoints[0]?.route)
      .filter((route): route is string => route !== undefined && route !== null);

    expect(titles).toEqual(
      expect.arrayContaining([
        "Fastify route GET /items",
        "Fastify route POST /items",
        "Fastify route DELETE /mixed",
        "Fastify route GET /indexed-mixed",
        "Fastify route PUT /const-items",
        "Fastify route PATCH /const-items",
        "Fastify route OPTIONS /satisfies-items",
        "Fastify route PATCH /template-static",
        "Fastify route GET /template-mixed",
        "Fastify route HEAD /template-mixed-tail",
      ]),
    );
    expect(routes.some((route) => route.endsWith(" /dynamic-only"))).toBe(false);
    expect(routes.some((route) => route.endsWith(" /numeric-only"))).toBe(false);
    expect(routes.filter((route) => route.endsWith(" /template-mixed"))).toEqual([
      "GET /template-mixed",
    ]);
    expect(routes.filter((route) => route.endsWith(" /template-mixed-tail"))).toEqual([
      "HEAD /template-mixed-tail",
    ]);
    expect(routes.some((route) => route.endsWith(" /template-dynamic"))).toBe(false);
  });

  it("keeps index route tests scoped to their route directory", async () => {
    const root = await fixtureRoot("clawpatch-node-server-index-route-tests-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "index-route-server",
          scripts: { test: "vitest run" },
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/routes/users/index.ts",
      [
        "import { Router } from 'express';",
        "",
        "const router = Router();",
        "router.get('/users', listUsers);",
        "function listUsers() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "src/routes/users/index.test.ts", "test('users', () => {});\n");
    await writeFixture(root, "src/routes/admin/index.test.ts", "test('admin', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "Express route GET /users");

    expect(route?.tests).toEqual([
      { path: "src/routes/users/index.test.ts", command: "npm run test" },
    ]);
  });

  it("keeps nested top-level Express routes scoped to their package", async () => {
    const root = await fixtureRoot("clawpatch-top-level-workspace-express-routes-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - api\n");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "root-server",
          scripts: { test: "vitest run root.test.ts" },
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "api/package.json",
      JSON.stringify(
        {
          name: "@scope/api",
          scripts: { test: "vitest run" },
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "api/src/server.ts",
      [
        "import express from 'express';",
        "",
        "const app = express();",
        "app.get('/health', health);",
        "function health() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "api/src/server.test.ts", "test('api route', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "Express route GET /health");

    expect(route?.tags).toEqual(expect.arrayContaining(["project:@scope/api", "project-root:api"]));
    expect(route?.tags).not.toContain("project:root-server");
    expect(route?.tests).toEqual([
      { path: "api/src/server.test.ts", command: "pnpm --dir api test" },
    ]);
  });

  it("does not scan nested packages without server route dependencies", async () => {
    const root = await fixtureRoot("clawpatch-node-server-nested-no-framework-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        { name: "root", workspaces: ["packages/*"], dependencies: { express: "1.0.0" } },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "packages/worker/package.json",
      JSON.stringify({ name: "worker", scripts: { test: "vitest run" } }, null, 2),
    );
    await writeFixture(
      root,
      "packages/worker/src/looks-like-server.ts",
      [
        "const app = { get(_path: string, _handler: unknown) {} };",
        "",
        "app.get('/worker-health', handler);",
        "function handler() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.map((feature) => feature.title)).not.toContain(
      "Express route GET /worker-health",
    );
  });

  it("keeps root entry route tests with root entry route features", async () => {
    const root = await fixtureRoot("clawpatch-node-root-entry-route-tests-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "root-entry-server",
          scripts: { test: "vitest run" },
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "server.ts",
      [
        "import express from 'express';",
        "",
        "const app = express();",
        "app.get('/root-health', health);",
        "function health() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "server.test.ts", "test('root server', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find(
      (feature) => feature.title === "Express route GET /root-health",
    );

    expect(route?.tests).toEqual([{ path: "server.test.ts", command: "npm run test" }]);
    expect(route?.contextFiles).toContainEqual({
      path: "server.test.ts",
      reason: "associated test",
    });
  });

  it("maps workspace Express routes with package-scoped validation", async () => {
    const root = await fixtureRoot("clawpatch-workspace-express-routes-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    await writeFixture(
      root,
      "packages/api/package.json",
      JSON.stringify(
        {
          name: "@scope/api",
          scripts: { test: "vitest run" },
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "packages/api/src/routes/users.ts",
      [
        "import { Router } from 'express';",
        "",
        "const usersRouter = Router();",
        "usersRouter.get('/users/:id', showUser);",
        "function showUser() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "packages/api/src/routes/users.test.ts",
      "test('users route', () => {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find(
      (feature) => feature.title === "Express route GET /users/:id",
    );

    expect(route?.tags).toEqual(expect.arrayContaining(["express", "route", "project:@scope/api"]));
    expect(route?.tests).toEqual([
      {
        path: "packages/api/src/routes/users.test.ts",
        command: "pnpm --dir packages/api test",
      },
    ]);
  });

  it("does not map route-like calls without a server framework dependency", async () => {
    const root = await fixtureRoot("clawpatch-node-route-false-positive-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify({ name: "client", dependencies: { axios: "1.0.0" } }, null, 2),
    );
    await writeFixture(
      root,
      "src/client.ts",
      "const app = client();\napp.get('/not-a-server-route');\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.some((feature) => feature.source.endsWith("-route"))).toBe(false);
  });

  it("does not map client calls inside server packages as routes", async () => {
    const root = await fixtureRoot("clawpatch-node-client-call-routes-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "mixed-server-client",
          dependencies: { express: "1.0.0", axios: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/client.ts",
      [
        "import axios from 'axios';",
        "",
        "const api = axios.create();",
        "api.get('/users');",
        "const app = createClient();",
        "app.post('/client-submit');",
        "const server = express();",
        "client.server.get('/nested-client');",
        "this.server.post('/nested-submit');",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("Express route GET /users");
    expect(titles).not.toContain("Express route POST /client-submit");
    expect(titles).not.toContain("Express route GET /nested-client");
    expect(titles).not.toContain("Express route POST /nested-submit");
  });

  it("maps Nx Express routes without a project-local package manifest", async () => {
    const root = await fixtureRoot("clawpatch-nx-express-routes-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "nx-root",
          packageManager: "pnpm@10.0.0",
          dependencies: { express: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "pnpm-lock.yaml", "");
    await writeFixture(
      root,
      "apps/api/project.json",
      JSON.stringify(
        {
          name: "api",
          sourceRoot: "apps/api/src",
          projectType: "application",
          targets: { test: {} },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "apps/api/src/server.mjs",
      [
        "import express from 'express';",
        "",
        "const app = express();",
        "app.get('/health', health);",
        "function health() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "apps/api/src/server.test.mjs", "test('server', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const route = result.features.find((feature) => feature.title === "Express route GET /health");

    expect(route?.entrypoints[0]).toMatchObject({
      path: "apps/api/src/server.mjs",
      symbol: "health",
      route: "GET /health",
    });
    expect(route?.tags).toEqual(expect.arrayContaining(["project:api", "project-root:apps/api"]));
    expect(route?.tests).toEqual([
      { path: "apps/api/src/server.test.mjs", command: "pnpm nx test api" },
    ]);
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
    await writeFixture(root, "bun.lock", "");
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

  it("maps Kotlin Android semantic roles from framework evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-role-map-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.application").version("1.0").apply(false) }\n',
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/RootController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.GetMapping",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class RootController {",
        '  @GetMapping("/root")',
        '  fun root(): String = "ok"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      "plugins { alias(libs.plugins.android.application) }\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.activity.ComponentActivity",
        "import androidx.compose.runtime.Composable",
        "import androidx.hilt.navigation.compose.hiltViewModel",
        "",
        "class MainActivity : ComponentActivity()",
        "",
        "@Composable",
        "fun HomeScreen() { hiltViewModel<MainViewModel>() }",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/ProfileFragment.kt",
      [
        "package com.example.ui",
        "",
        "import dagger.hilt.android.AndroidEntryPoint",
        "",
        "@AndroidEntryPoint",
        "class ProfileFragment : BaseFragment()",
        "",
        "open class BaseFragment",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/SettingsActivity.kt",
      "package com.example.ui\nclass SettingsActivity : androidx.activity.ComponentActivity()\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.*",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/data/AppDatabase.kt",
      [
        "package com.example.data",
        "",
        "import androidx.room.Database",
        "import androidx.room.RoomDatabase",
        "",
        "@Database(entities = [], version = 1)",
        "abstract class AppDatabase : RoomDatabase()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/data/UserRepository.kt",
      [
        "package com.example.data",
        "",
        "import javax.inject.Inject",
        "",
        "class UserRepository @Inject constructor()",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/network/ApiClient.kt",
      [
        "package com.example.network",
        "",
        "import retrofit2.Retrofit",
        "",
        "class ApiClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/di/AppGraph.kt",
      [
        "package com.example.di",
        "",
        "import dev.zacsweers.metro.BindingContainer",
        "import dev.zacsweers.metro.DependencyGraph",
        "import dev.zacsweers.metro.Provides",
        "",
        "@DependencyGraph",
        "interface AppGraph",
        "",
        "@BindingContainer",
        "object AppBindings {",
        '  @Provides fun provideName(): String = "app"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/UseCase.kt",
      "package com.example.domain\nclass UseCase\n",
    );
    await writeFixture(
      root,
      "app/src/test/kotlin/com/example/ui/MainActivityTest.kt",
      "package com.example.ui\nclass MainActivityTest\n",
    );
    await writeFixture(
      root,
      "app/build/generated/source/kapt/debug/com/example/Ignored.kt",
      "package com.example\nclass Ignored\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const gradleModule = result.features.find((feature) => feature.title === "Gradle module app");
    const ui = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role UI entrypoint "),
    );
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );
    const data = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role data boundary "),
    );
    const client = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role external client "),
    );
    const di = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role dependency injection "),
    );
    const rootModule = result.features.find((feature) => feature.title === "Gradle module .");
    const rootWeb = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/RootController.kt",
        ),
    );

    expect(project.detected.languages).toContain("kotlin");
    expect(project.detected.packageManagers).toContain("gradle");
    expect(titles).toContain("Gradle module app");
    expect(rootModule?.tags).not.toContain("android");
    expect(rootWeb?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(gradleModule?.tags).toEqual(expect.arrayContaining(["gradle", "kotlin", "android"]));
    expect(ui?.source).toBe("kotlin-android-role-ui-entrypoint");
    expect(ui?.kind).toBe("ui-flow");
    expect(ui?.confidence).toBe("high");
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
    );
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/ProfileFragment.kt",
    );
    expect(ui?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/ui/SettingsActivity.kt",
    );
    expect(ui?.tests).toEqual([
      { path: "app/src/test/kotlin/com/example/ui/MainActivityTest.kt", command: null },
    ]);
    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(viewModel?.ownedFiles.map((file) => file.path)).not.toContain(
      "app/src/main/kotlin/com/example/ui/MainActivity.kt",
    );
    expect(data?.trustBoundaries).toEqual(expect.arrayContaining(["database", "serialization"]));
    expect(data?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/data/UserRepository.kt",
    );
    expect(client?.trustBoundaries).toEqual(
      expect.arrayContaining(["network", "external-api", "serialization"]),
    );
    expect(di?.source).toBe("kotlin-android-role-dependency-injection");
    expect(di?.ownedFiles.map((file) => file.path)).toContain(
      "app/src/main/kotlin/com/example/di/AppGraph.kt",
    );
    expect(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    ).not.toContain("app/build/generated/source/kapt/debug/com/example/Ignored.kt");
  });

  it("maps server-side Kotlin roles and path fallback evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-server-role-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.GetMapping",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController {",
        '  @GetMapping("/orders")',
        '  fun list(): String = "ok"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/QualifiedController.kt",
      [
        "package com.example.api",
        "",
        "@org.springframework.web.bind.annotation.RestController",
        "class QualifiedController",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/BillingService.kt",
      [
        "package com.example.app",
        "",
        "import jakarta.inject.Singleton",
        "",
        "@Singleton",
        "class BillingService",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/db/OrderRepository.kt",
      [
        "package com.example.db",
        "",
        "import org.springframework.data.repository.CrudRepository",
        "",
        "interface OrderRepository : CrudRepository<Order, String>",
        "class Order",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/RemoteClient.kt",
      [
        "package com.example.client",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class RemoteClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/GitHubApi.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.http.GET",
        "",
        "interface GitHubApi {",
        '  @GET("/users")',
        "  fun users(): String",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/PaymentClient.kt",
      "package com.example.network\ninterface PaymentClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/config/AppConfig.kt",
      [
        "package com.example.config",
        "",
        "import org.springframework.context.annotation.Bean",
        "import org.springframework.context.annotation.Configuration",
        "",
        "@Configuration",
        "class AppConfig {",
        '  @Bean fun name(): String = "orders"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/test/kotlin/com/example/api/OrderControllerTest.kt",
      "package com.example.api\nclass OrderControllerTest\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );
    const service = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role application service "),
    );
    const persistence = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role persistence boundary "),
    );
    const clientFeatures = result.features.filter((feature) =>
      feature.title.startsWith("Kotlin server role external client "),
    );
    const configuration = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role configuration "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(web?.ownedFiles.map((file) => file.path)).not.toContain(
      "src/main/kotlin/com/example/client/GitHubApi.kt",
    );
    expect(web?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/api/QualifiedController.kt",
    );
    expect(web?.tests).toEqual([
      { path: "src/test/kotlin/com/example/api/OrderControllerTest.kt", command: null },
    ]);
    expect(service?.source).toBe("kotlin-server-role-application-service");
    expect(persistence?.source).toBe("kotlin-server-role-persistence-boundary");
    expect(configuration?.source).toBe("kotlin-server-role-configuration");
    expect(configuration?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/config/AppConfig.kt",
    );
    const clientFiles = clientFeatures.flatMap((feature) =>
      feature.ownedFiles.map((file) => file.path),
    );
    expect(clientFeatures).toHaveLength(1);
    expect(clientFeatures[0]?.confidence).toBe("high");
    expect(clientFiles).toEqual(
      expect.arrayContaining([
        "src/main/kotlin/com/example/client/GitHubApi.kt",
        "src/main/kotlin/com/example/client/RemoteClient.kt",
        "src/main/kotlin/com/example/network/FallbackClient.kt",
        "src/main/kotlin/com/example/network/PaymentClient.kt",
      ]),
    );
  });

  it("does not add path-only roles to strong Kotlin server roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-strong-role-path-fallback-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/OrderController.kt",
      [
        "package com.example.network",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/OrderController.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/OrderController.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin Spring configuration imports as configuration roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-spring-config-import-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/config/PropsConfig.kt",
      [
        "package com.example.config",
        "",
        "import org.springframework.boot.context.properties.EnableConfigurationProperties",
        "",
        "@EnableConfigurationProperties(AppProps::class)",
        "class PropsConfig",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const configuration = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-configuration" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/config/PropsConfig.kt",
        ),
    );

    expect(configuration?.ownedFiles[0]?.reason).toContain(
      "configuration import org.springframework.boot.context.properties.EnableConfigurationProperties",
    );
  });

  it("keeps Kotlin feature IDs stable when confidence changes", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-role-id-stability-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/BackupClient.kt",
      "package com.example.network\nclass BackupClient\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const fallbackBefore = first.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/FallbackClient.kt",
        ),
    );

    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      [
        "package com.example.network",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class FallbackClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );

    const second = await mapFeatures(root, project, first.features);
    const fallbackAfter = second.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/FallbackClient.kt",
        ),
    );

    expect(fallbackBefore?.confidence).toBe("medium");
    expect(fallbackAfter?.confidence).toBe("high");
    expect(fallbackAfter?.featureId).toBe(fallbackBefore?.featureId);
    expect(fallbackAfter?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/main/kotlin/com/example/network/BackupClient.kt",
      "src/main/kotlin/com/example/network/FallbackClient.kt",
    ]);
  });

  it("does not infer Android roles from non-Android Gradle module paths", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-path-leak-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "apps/android/build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "plugins {",
        "  alias(libs.plugins.android.application)",
        "    .apply(false)",
        "}",
        '// id("com.android.application")',
        '/* android { namespace = "example" } */',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "apps/android/src/main/kotlin/com/example/di/Injector.kt",
      "package com.example.di\nclass Injector\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
    expect(
      result.features.find((feature) => feature.title === "Gradle module apps/android")?.tags,
    ).not.toContain("android");
  });

  it("detects legacy Android Gradle plugin application syntax", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-legacy-gradle-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", 'apply plugin: "com.android.library"\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.activity.ComponentActivity",
        "",
        "class MainActivity : ComponentActivity()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(result.features.find((feature) => feature.title === "Gradle module .")?.tags).toContain(
      "android",
    );
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not treat non-entrypoint Android framework imports as UI roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-non-ui-import-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/alerts/Notifier.kt",
      [
        "package com.example.alerts",
        "",
        "import android.app.Notification",
        "import android.app.PendingIntent",
        "",
        "class Notifier(private val notification: Notification, private val intent: PendingIntent)",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/alerts/Notifier.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat project-local Android supertype names as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-local-supertype-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/Service.kt",
      "package com.example.domain\nopen class Service\n",
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/domain/Billing.kt",
      "package com.example.domain\nclass Billing : Service()\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/domain/Billing.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat Compose runtime state imports as UI roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-compose-state-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/state/CounterState.kt",
      [
        "package com.example.state",
        "",
        "import androidx.compose.runtime.mutableStateOf",
        "",
        "class CounterState {",
        "  val count = mutableStateOf(0)",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/state/CounterState.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin role evidence from wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-wildcard-imports-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/RemoteClient.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.*",
        "",
        "class RemoteClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "app/build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(root, "app/src/main/AndroidManifest.xml", "<manifest />\n");
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/bootstrap/AppModule.kt",
      [
        "package com.example.bootstrap",
        "",
        "import org.koin.dsl.*",
        "",
        'fun appModule() = module { single { "value" } }',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const client = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/client/RemoteClient.kt",
        ),
    );
    const di = result.features.find(
      (feature) =>
        feature.source === "kotlin-android-role-dependency-injection" &&
        feature.ownedFiles.some(
          (file) => file.path === "app/src/main/kotlin/com/example/bootstrap/AppModule.kt",
        ),
    );

    expect(client?.ownedFiles[0]?.reason).toContain("retrofit2.*");
    expect(di?.ownedFiles[0]?.reason).toContain("org.koin.dsl.*");
  });

  it("maps server-side Kotlin declaration role evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-declaration-role-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ports/PaymentPort.kt",
      "package com.example.ports\nfun interface PaymentPort { fun pay() }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/domain/Job.kt",
      "package com.example.domain\nclass Job\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import kotlin.time.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : LocalBase(), JobFactoryBase<Job>() {",
        "  fun buildJob(): Job = TODO()",
        "  fun local(): LocalBase = TODO()",
        '  fun label(): String = "job"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/LocalBase.kt",
      "package com.example.jobs\nopen class LocalBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const extension = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role extension boundary "),
    );
    const framework = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role framework component "),
    );

    expect(extension?.source).toBe("kotlin-server-role-extension-boundary");
    expect(extension?.confidence).toBe("medium");
    expect(extension?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/ports/PaymentPort.kt",
    );
    expect(
      extension?.ownedFiles.find(
        (file) => file.path === "src/main/kotlin/com/example/ports/PaymentPort.kt",
      )?.reason,
    ).toContain("interface declaration PaymentPort");
    expect(framework?.source).toBe("kotlin-server-role-framework-component");
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
    );
    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
    expect(framework?.ownedFiles[0]?.reason).not.toContain("org.scheduler.LocalBase");
    expect(framework?.ownedFiles[0]?.reason).not.toContain("org.scheduler.String");
  });

  it("does not let settings-only root sources suppress module Kotlin wildcard evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-settings-root-src-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":app")\n');
    await writeFixture(
      root,
      "src/main/kotlin/org/scheduler/Unused.kt",
      "package org.scheduler\nclass Unused\n",
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "app/src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("org.scheduler.JobFactoryBase");
  });

  it("does not let nested Gradle roots suppress outer Kotlin wildcard evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-root-local-type-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "nested/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "nested/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "nested/src/main/kotlin/org/scheduler/JobFactoryBase.kt",
      "package org.scheduler\nclass JobFactoryBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps nested Gradle roots under settings builds independently", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-settings-nested-root-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "nested/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "nested/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "nested/src/main/kotlin/org/scheduler/JobFactoryBase.kt",
      "package org.scheduler\nclass JobFactoryBase\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const nestedModule = result.features.find(
      (feature) => feature.title === "Gradle module nested",
    );
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(nestedModule?.source).toBe("gradle-module");
    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("does not treat Kotlin stdlib return types as framework components", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-stdlib-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/util/Timeouts.kt",
      [
        "package com.example.util",
        "",
        "import kotlin.time.Duration",
        "",
        "fun timeout(): Duration = Duration.ZERO",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/util/Timeouts.kt",
          ),
      ),
    ).toBe(false);
  });

  it("filters mixed Java/Kotlin module types from Kotlin framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-local-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/framework/BaseHandler.java",
      "package com.example.framework; public class BaseHandler {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Handler.kt",
      [
        "package com.example.api",
        "",
        "import com.example.framework.BaseHandler",
        "",
        "class Handler : BaseHandler()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/Handler.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin supertypes with constructor arguments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-args-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Handler.kt",
      [
        "package com.example.jobs",
        "",
        "import org.framework.FrameworkBase",
        "",
        "class Handler(callback: () -> Unit) : FrameworkBase(dep = dep, config = config)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/InjectedHandler.kt",
      [
        "package com.example.jobs",
        "",
        "import jakarta.inject.Inject",
        "import org.framework.FrameworkBase",
        "",
        "class InjectedHandler @Inject constructor(dep: Any) : FrameworkBase(dep)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/InternalHandler.kt",
      [
        "package com.example.jobs",
        "",
        "import org.framework.FrameworkBase",
        "",
        "class InternalHandler internal constructor(dep: Any) : FrameworkBase(dep)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/QualifiedHandler.kt",
      [
        "package com.example.jobs",
        "",
        "class QualifiedHandler : org.framework.FrameworkBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/Handler.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.framework.FrameworkBase");
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/InjectedHandler.kt",
    );
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/InternalHandler.kt",
    );
    expect(framework?.ownedFiles.map((file) => file.path)).toContain(
      "src/main/kotlin/com/example/jobs/QualifiedHandler.kt",
    );
  });

  it("maps Kotlin Spring components as application services", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-spring-component-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/BillingComponent.kt",
      [
        "package com.example.app",
        "",
        "import org.springframework.stereotype.Component",
        "",
        "@Component",
        "class BillingComponent",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const service = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-application-service" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/app/BillingComponent.kt",
        ),
    );

    expect(service?.ownedFiles[0]?.reason).toContain("service annotation @Component");
  });

  it("does not treat qualified Kotlin annotations as type imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-annotation-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/Billing.kt",
      [
        "package com.example.app",
        "",
        "@org.springframework.stereotype.Service",
        "class Billing : Service",
        "interface Service",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/Billing.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-application-service" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/Billing.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not treat project-local nested Kotlin types as external frameworks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-nested-type-map-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Outer.kt",
      [
        "package com.example",
        "",
        "class Outer { open class Base }",
        "class Handler : Outer.Base()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/Outer.kt"),
      ),
    ).toBe(false);
  });

  it("ignores Kotlin role markers inside nested block comments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-comment-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Foo.kt",
      [
        "package com.example",
        "",
        "/* outer",
        "  /* inner */",
        "  import okhttp3.OkHttpClient",
        "  import org.springframework.web.bind.annotation.RestController",
        "  @RestController",
        "*/",
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" ||
          feature.source === "kotlin-server-role-web-entrypoint",
      ),
    ).toBe(false);
  });

  it("keeps Kotlin code after comment markers inside strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-string-comment-marker-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Foo.kt",
      [
        "package com.example.api",
        "",
        'const val marker = "/*"',
        "",
        "@org.springframework.web.bind.annotation.RestController",
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/api/Foo.kt"),
      ),
    ).toBe(true);
  });

  it("ignores Kotlin role markers inside raw strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-raw-string-marker-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Foo.kt",
      [
        "package com.example",
        "",
        'val template = """',
        "import okhttp3.OkHttpClient",
        "@org.springframework.web.bind.annotation.RestController",
        '"""',
        "class Foo",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" ||
          feature.source === "kotlin-server-role-web-entrypoint",
      ),
    ).toBe(false);
  });

  it("keeps Kotlin role IDs stable when confidence buckets merge", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-role-bucket-stability-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/RemoteClient.kt",
      [
        "package com.example.network",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class RemoteClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "package com.example.network\nclass FallbackClient\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const before = first.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/RemoteClient.kt",
        ),
    );

    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      [
        "package com.example.network",
        "",
        "import retrofit2.Retrofit",
        "",
        "class FallbackClient(private val retrofit: Retrofit)",
        "",
      ].join("\n"),
    );

    const second = await mapFeatures(root, project, first.features);
    const after = second.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/network/RemoteClient.kt",
        ),
    );

    expect(before?.featureId).toBeDefined();
    expect(after?.featureId).toBe(before?.featureId);
    expect(after?.ownedFiles.map((file) => file.path).toSorted()).toEqual([
      "src/main/kotlin/com/example/network/FallbackClient.kt",
      "src/main/kotlin/com/example/network/RemoteClient.kt",
    ]);
  });

  it("does not treat Java sources from the same Gradle module as external Kotlin framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-local-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/core/BaseService.java",
      "package com.example.core;\npublic class BaseService {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/app/LocalService.kt",
      [
        "package com.example.app",
        "",
        "import com.example.core.BaseService",
        "",
        "class LocalService : BaseService()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/app/LocalService.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat sibling Gradle module Kotlin types as external framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-sibling-module-type-");
    await writeFixture(
      root,
      "settings.gradle.kts",
      'pluginManagement {}\ninclude(":core", ":app")\n',
    );
    await writeFixture(
      root,
      "core/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "app/build.gradle.kts",
      'plugins { id("org.jetbrains.kotlin.jvm") }\n',
    );
    await writeFixture(
      root,
      "core/src/main/kotlin/com/example/core/BaseService.kt",
      ["package com.example.core", "", "open class BaseService", ""].join("\n"),
    );
    await writeFixture(
      root,
      "app/src/main/kotlin/com/example/app/AppService.kt",
      [
        "package com.example.app",
        "",
        "import com.example.core.BaseService",
        "",
        "class AppService : BaseService()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "app/src/main/kotlin/com/example/app/AppService.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat same-package nested Kotlin types as external framework types", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-nested-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      ["package com.example.jobs", "", "class Job {", "  class Factory", "}", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactoryProvider.kt",
      [
        "package com.example.jobs",
        "",
        "class JobFactoryProvider {",
        "  fun build(): Job.Factory = Job.Factory()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactoryProvider.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from Gradle plugins without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-role-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":ui")\n');
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.library") version "1.0" apply false }\n',
    );
    await writeFixture(root, "ui/build.gradle.kts", 'plugins { id("com.android.library") }\n');
    await writeFixture(
      root,
      "ui/src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "ui/src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from convention plugin android blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-convention-block-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.company.android.library") version "1.0"',
        "}",
        "",
        "android {",
        '  namespace = "com.example"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from multiline Gradle plugin declarations", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-multiline-plugin-role-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      ["plugins {", "  id(", '    "com.android.library"', "  )", "}", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat child android extension blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-child-extension-block-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "subprojects {",
        "  android {",
        '    namespace = "com.example.child"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("keeps applied Android plugin declarations before unrelated alias apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-alias-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  alias(libs.plugins.kotlin.compose) apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Groovy Android plugin declarations before unrelated apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-groovy-apply-false-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins {",
        "  id 'com.android.application' version '8.0'",
        "  id 'org.jetbrains.kotlin.jvm' version '1.9' apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before unrelated shorthand apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-shorthand-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        '  kotlin("jvm") apply false',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before unrelated backtick apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-backtick-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  `java-library` apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Kotlin DSL Android plugin declarations before bare accessor apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-accessor-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "  application apply false",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps Android plugin declarations before same-line unrelated apply false entries", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-same-line-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      'plugins { id("com.android.application"); id("org.jetbrains.kotlin.jvm") apply false }\n',
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("keeps final Android plugin declarations before later unrelated apply false text", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-trailing-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "8.0"',
        "}",
        "",
        'tasks.register("note") {',
        '  doLast { println("call .apply(false) elsewhere") }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from version-catalog plugin aliases without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-alias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      "plugins { alias(libs.plugins.android.library) }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from bare plugin aliases without a catalog", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-bare-plugin-alias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.android) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from later wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-wildcard-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import com.external.*",
        "import androidx.lifecycle.*",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects Android Kotlin roles from resolved version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not read parent version-catalog aliases from nested Gradle roots", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-nested-catalog-shadow-");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "server/settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "server/gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "org.jetbrains.kotlin.jvm", version = "1.9" }', ""].join("\n"),
    );
    await writeFixture(root, "server/build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "server/src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const module = result.features.find((feature) => feature.title === "Gradle module server");
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "server/src/main/kotlin/com/example/api/OrderController.kt",
        ),
    );

    expect(module?.tags).not.toContain("android");
    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
  });

  it("does not read subproject-local version catalogs from Gradle root subprojects", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-root-catalog-subproject-");
    await writeFixture(root, "settings.gradle.kts", 'pluginManagement {}\ninclude(":server")\n');
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "org.jetbrains.kotlin.jvm", version = "1.9" }', ""].join("\n"),
    );
    await writeFixture(
      root,
      "server/gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "server/build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "server/src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const module = result.features.find((feature) => feature.title === "Gradle module server");
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "server/src/main/kotlin/com/example/api/OrderController.kt",
        ),
    );

    expect(module?.tags).not.toContain("android");
    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
  });

  it("detects Android Kotlin roles from quoted version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-quoted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", '"agp.lib" = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp.lib) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not treat version-catalog Android plugin aliases inside Gradle strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-alias-string-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'tasks.register("note") {',
        '  doLast { println("alias(libs.plugins.agp)") }',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from dotted-key version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-dotted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins]", 'agp.id = "com.android.library"', 'agp.version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from top-level dotted version-catalog plugin aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-top-dotted-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ['plugins.agp = { id = "com.android.library", version = "8.0.0" }', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from plugin-specific version-catalog tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-plugin-table-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins.agp]", 'id = "com.android.library"', 'version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from quoted plugin-specific version-catalog tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-quoted-plugin-table-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ['[plugins."agp"]', 'id = "com.android.library"', 'version = "8.0.0"', ""].join("\n"),
    );
    await writeFixture(root, "build.gradle.kts", "plugins { alias(libs.plugins.agp) }\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from nested version-catalog plugin tables", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-nested-plugin-catalog-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "gradle/libs.versions.toml",
      ["[plugins.android]", 'gradle = { id = "com.android.library", version = "8.0.0" }', ""].join(
        "\n",
      ),
    );
    await writeFixture(
      root,
      "build.gradle.kts",
      "plugins { alias(libs.plugins.android.gradle) }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from applied Gradle plugin syntax without a manifest", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-plugin-role-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "apply plugin: 'com.android.library'\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from Groovy apply plugin syntax with spaced colons", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-spaced-colon-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", "apply plugin : 'com.android.library'\n");
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects Android Kotlin roles from Groovy apply plugin map syntax", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-map-role-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle", 'apply(plugin: "com.android.library")\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
  });

  it("detects root Android apply plugin after Gradle URL strings", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-url-string-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "subprojects {",
        "  repositories {",
        "    maven { url 'https://example.com/repo' }",
        "  }",
        "}",
        "apply plugin: 'com.android.library'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android apply plugin after Gradle child-scope string braces", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-string-brace-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "subprojects {",
        "  tasks.register('note') { doLast { println('{') } }",
        "}",
        "apply plugin: 'com.android.library'",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android roles from allprojects apply plugin blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-allprojects-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "allprojects {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("detects root Android roles from allprojects android blocks", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-allprojects-extension-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        "allprojects {",
        "  android {",
        '    namespace = "com.example"',
        "  }",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const viewModel = result.features.find((feature) =>
      feature.title.startsWith("Kotlin Android role view model "),
    );

    expect(viewModel?.source).toBe("kotlin-android-role-view-model");
  });

  it("does not treat subproject Android apply blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-subprojects-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "subprojects {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat project Android apply blocks as root Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-project-apply-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins { id 'org.jetbrains.kotlin.jvm' }",
        "project(':app') {",
        "  apply plugin: 'com.android.library'",
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application") version "1.0" apply false',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Android apply syntax inside Gradle raw strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-raw-string-apply-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'val sample = """',
        "apply plugin: 'com.android.library'",
        '"""',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Android extension blocks inside Gradle raw strings as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-raw-string-extension-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        'plugins { id("org.jetbrains.kotlin.jvm") }',
        'val sample = """',
        "android { namespace = 'com.example' }",
        '"""',
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false Android plugin declarations with GString versions as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-gstring-apply-false-");
    await writeFixture(root, "settings.gradle", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle",
      [
        "plugins {",
        '  id "com.android.application" version "${agpVersion}" apply false',
        '  id "org.jetbrains.kotlin.jvm"',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat apply-false version-catalog Android plugin aliases as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-alias-apply-false-module-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        "  alias(libs.plugins.android.library) apply false",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-apply-method-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application").version("8.0").apply(false)',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat multiline Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-multiline-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application")',
        '    .version("8.0")',
        "    .apply(false)",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat split Kotlin DSL apply(false) Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-split-apply-false-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("com.android.application")',
        '    .version("8.0")',
        "    .apply(",
        "      false",
        "    )",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat commented Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-commented-plugin-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  // id("com.android.application")',
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not treat nested-commented Kotlin DSL Android plugin declarations as Android modules", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-nested-comment-plugin-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(
      root,
      "build.gradle.kts",
      [
        "plugins {",
        '  id("org.jetbrains.kotlin.jvm")',
        "}",
        "/* outer",
        "  /* inner */",
        '  id("com.android.application")',
        "*/",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.RestController",
        "",
        "@RestController",
        "class OrderController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find((feature) =>
      feature.title.startsWith("Kotlin server role web entrypoint "),
    );

    expect(web?.source).toBe("kotlin-server-role-web-entrypoint");
    expect(
      result.features.some((feature) => feature.source.startsWith("kotlin-android-role-")),
    ).toBe(false);
  });

  it("does not map Compose runtime-only imports as Android UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-compose-runtime-only-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainViewModel.kt",
      [
        "package com.example.ui",
        "",
        "import androidx.compose.runtime.mutableStateOf",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel() {",
        '  val name = mutableStateOf("app")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-view-model" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainViewModel.kt",
          ),
      ),
    ).toBe(true);
  });

  it("keeps Android UI path fallback for injected base activities", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-ui-di-path-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/MainActivity.kt",
      [
        "package com.example.ui",
        "",
        "import dagger.hilt.android.AndroidEntryPoint",
        "",
        "@AndroidEntryPoint",
        "class MainActivity : BaseActivity()",
        "",
        "open class BaseActivity",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-dependency-injection" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/MainActivity.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not add Android path roles after strong framework evidence", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-strong-role-path-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/ui/ApiClient.kt",
      [
        "package com.example.ui",
        "",
        "import okhttp3.OkHttpClient",
        "",
        "class ApiClient(private val client: OkHttpClient)",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/MainViewModel.kt",
      [
        "package com.example.network",
        "",
        "import androidx.lifecycle.ViewModel",
        "",
        "class MainViewModel : ViewModel()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/ApiClient.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/MainViewModel.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/ui/ApiClient.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-view-model" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/MainViewModel.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not map Android app utility imports as UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-app-utility-import-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/notifications/NotificationHelper.kt",
      [
        "package com.example.notifications",
        "",
        "import android.app.NotificationChannel",
        "import android.app.PendingIntent",
        "",
        "class NotificationHelper {",
        '  fun channel(): NotificationChannel = NotificationChannel("id", "name", 3)',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) =>
              file.path === "src/main/kotlin/com/example/notifications/NotificationHelper.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map local Android supertype name collisions as UI entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-local-activity-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/domain/LocalActivity.kt",
      [
        "package com.example.domain",
        "",
        "open class Activity",
        "",
        "class CleanupJob : Activity()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-ui-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/domain/LocalActivity.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps Kotlin Apache HTTP imports as external clients", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-apache-http-client-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/LegacyClient.kt",
      [
        "package com.example.client",
        "",
        "import org.apache.http.client.HttpClient",
        "",
        "class LegacyClient(private val client: HttpClient)",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const client = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-external-client" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/client/LegacyClient.kt",
        ),
    );

    expect(client?.ownedFiles[0]?.reason).toContain(
      "external client import org.apache.http.client.HttpClient",
    );
  });

  it("keeps injected Android data consumers in data role path fallback", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-android-injected-data-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("com.android.application") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/data/UserRepository.kt",
      [
        "package com.example.data",
        "",
        "import javax.inject.Inject",
        "",
        "class UserRepository @Inject constructor()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const data = result.features.find(
      (feature) =>
        feature.source === "kotlin-android-role-data-boundary" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/data/UserRepository.kt",
        ),
    );

    expect(data?.ownedFiles[0]?.reason).toContain("path segment data boundary");
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-android-role-dependency-injection" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/data/UserRepository.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map Retrofit client annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-retrofit-annotation-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/client/ApiClient.kt",
      [
        "package com.example.client",
        "",
        "import retrofit2.http.GET",
        "",
        "interface ApiClient {",
        '  @GET("/orders")',
        "  fun orders(): String",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/client/ApiClient.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/client/ApiClient.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not map qualified custom web-like annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-custom-qualified-web-annotation-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/LocalController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@com.acme.RestController",
        "class LocalController",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/LocalController.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps fully qualified Kotlin JAX-RS annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-jaxrs-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        '@jakarta.ws.rs.Path("/orders")',
        "class OrderResource",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(web?.ownedFiles[0]?.reason).toContain("server web annotation @Path");
  });

  it("maps later fully qualified Kotlin JAX-RS annotations as server web entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-jaxrs-after-custom-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        "@com.acme.Path",
        '@jakarta.ws.rs.Path("/orders")',
        "class OrderResource",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const web = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-web-entrypoint" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(web?.ownedFiles[0]?.reason).toContain("server web annotation @Path");
  });

  it("maps fully qualified Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-qualified-return-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderResource.kt",
      [
        "package com.example.api",
        "",
        "class OrderResource {",
        "  fun response(): io.ktor.server.response.ApplicationResponse = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/OrderResource.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "returns external type io.ktor.server.response.ApplicationResponse",
    );
  });

  it("maps Kotlin supertypes after the first line of a declaration", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-multiline-supertypes-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Worker.kt",
      [
        "package com.example.jobs",
        "",
        "import io.ktor.server.application.Application",
        "",
        "open class LocalWorker",
        "",
        "class Worker :",
        "  LocalWorker,",
        "  Application {",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/Worker.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type io.ktor.server.application.Application",
    );
  });

  it("maps Kotlin supertypes before generic where constraints", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-where-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/ApiRoute.kt",
      [
        "package com.example.api",
        "",
        "import io.ktor.server.routing.Route",
        "",
        "class ApiRoute<T> : Route",
        "  where T : Any",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/ApiRoute.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type io.ktor.server.routing.Route",
    );
  });

  it("does not strip where package segments from Kotlin supertypes", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-where-package-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/where/Route.kt",
      ["package com.where", "", "open class Route", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/ApiRoute.kt",
      ["package com.example.api", "", "class ApiRoute : com.where.Route()", ""].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/ApiRoute.kt",
          ),
      ),
    ).toBe(false);
  });

  it("maps bodyless Kotlin supertypes before top-level functions", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "fun helper() = Unit",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before expect and actual declarations", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-expect-actual-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "actual class NativeJob",
        "expect fun scheduleJob()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before modified top-level functions", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-suspend-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "suspend fun runJob() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps bodyless Kotlin supertypes before top-level type aliases", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-bodyless-supertype-typealias-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
        "typealias JobId = String",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("maps Kotlin return types after function-typed parameters", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-function-param-return-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Router.kt",
      [
        "package com.example.api",
        "",
        "import org.http4k.routing.Route",
        "",
        "class Router {",
        "  fun route(block: () -> Unit): Route = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const component = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/Router.kt",
        ),
    );

    expect(component?.ownedFiles[0]?.reason).toContain(
      "returns external type org.http4k.routing.Route",
    );
  });

  it("does not resolve Kotlin built-in return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-builtin-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/OrderController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@RestController",
        "class OrderController {",
        '  @GetMapping("/orders")',
        '  fun body(): ByteArray = "ok".encodeToByteArray()',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/OrderController.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/OrderController.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not resolve Kotlin default return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-default-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun failure(): Throwable = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve Kotlin range return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-range-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/RangeController.kt",
      [
        "package com.example.api",
        "",
        "import org.springframework.web.bind.annotation.*",
        "",
        "@RestController",
        "class RangeController {",
        "  fun ids(): ClosedRange<Int> = 1..3",
        '  fun version(): KotlinVersion = KotlinVersion(1, 9, 0, "stable")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/RangeController.kt",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-web-entrypoint" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/RangeController.kt",
          ),
      ),
    ).toBe(true);
  });

  it("does not resolve dotted Kotlin built-in return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-dotted-builtin-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Entries.kt",
      [
        "package com.example.api",
        "",
        "class Entries {",
        "  fun first(): Map.Entry<String, String> = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/api/Entries.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/Routes.kt",
      [
        "package com.example",
        "",
        "object routes { class Handler }",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some((file) => file.path === "src/main/kotlin/com/example/Routes.kt"),
      ),
    ).toBe(false);
  });

  it("does not resolve imported local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-imported-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/routes/Routes.kt",
      ["package com.example.routes", "", "object routes { class Handler }", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/Factory.kt",
      [
        "package com.example.factory",
        "",
        "import com.example.routes.routes",
        "",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/Factory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve wildcard-imported local lowercase dotted Kotlin return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-wildcard-local-lowercase-dotted-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/routes/Routes.kt",
      ["package com.example.routes", "", "object routes { class Handler }", ""].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/Factory.kt",
      [
        "package com.example.factory",
        "",
        "import com.example.routes.*",
        "",
        "class Factory { fun handler(): routes.Handler = TODO() }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/Factory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve JVM default return types through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-jvm-default-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun worker(): Runnable = Runnable { }",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve explicitly imported Kotlin stdlib return types as framework roles", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-stdlib-direct-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/time/Timer.kt",
      [
        "package com.example.time",
        "",
        "import kotlin.time.Duration",
        "",
        "class Timer {",
        "  fun elapsed(): Duration = Duration.ZERO",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/time/Timer.kt",
          ),
      ),
    ).toBe(false);
  });

  it("resolves explicit Kotlin imports that shadow default built-in names", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-explicit-builtin-shadow-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/api/Controller.kt",
      [
        "package com.example.api",
        "",
        "import com.external.Result",
        "",
        "class Controller {",
        "  fun result(): Result = TODO()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/api/Controller.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("returns external type com.external.Result");
  });

  it("does not resolve local Kotlin declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "data class Job(val id: String)",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("does not resolve package-local Kotlin declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-package-local-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      "package com.example.jobs\nclass Job(val id: String)\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("prefers local Kotlin wildcard declarations over earlier external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-precedence-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/Job.kt",
      "package com.example.jobs\nclass Job(val id: String)\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/factory/JobFactory.kt",
      [
        "package com.example.factory",
        "",
        "import org.scheduler.*",
        "import com.example.jobs.*",
        "",
        "class JobFactory {",
        '  fun buildJob(): Job = Job("1")',
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/factory/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("skips non-matching local Kotlin wildcard imports before external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-local-wildcard-skip-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/local/Other.kt",
      "package com.example.local\nclass Other\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import com.example.local.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("skips non-external Kotlin wildcard imports before external wildcards", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-non-external-wildcard-skip-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import java.util.*",
        "import org.scheduler.*",
        "",
        "class JobFactory : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain(
      "inherits external type org.scheduler.JobFactoryBase",
    );
  });

  it("does not resolve same-package Java declarations through wildcard imports", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-java-wildcard-type-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/java/com/example/jobs/Job.java",
      "package com.example.jobs;\npublic class Job {}\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.*",
        "",
        "class JobFactory {",
        "  fun buildJob(): Job = Job()",
        "}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
          ),
      ),
    ).toBe(false);
  });

  it("preserves path roles for Kotlin interfaces", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-interface-path-roles-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/network/RemoteApi.kt",
      "package com.example.network\ninterface RemoteApi { fun call(): String }\n",
    );
    await writeFixture(
      root,
      "src/main/kotlin/com/example/repository/UserRepository.kt",
      [
        "package com.example.repository",
        "",
        "import kotlinx.coroutines.flow.Flow",
        "",
        "interface UserRepository { fun users(): Flow<String> }",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-external-client" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/network/RemoteApi.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-persistence-boundary" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/repository/UserRepository.kt",
          ),
      ),
    ).toBe(true);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "kotlin-server-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/kotlin/com/example/repository/UserRepository.kt",
          ),
      ),
    ).toBe(true);
  });

  it("maps Kotlin supertypes after annotated primary constructors", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-annotated-constructor-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import javax.inject.Inject",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory @Inject constructor(private val dep: String) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes after visibility-before-annotation constructors", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-constructor-modifier-order-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import javax.inject.Inject",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory public @Inject constructor(private val dep: String) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes after function-typed constructor parameters", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-function-param-constructor-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        "class JobFactory(cb: () -> Unit) : JobFactoryBase()",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes with constructor call commas", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-call-comma-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        'class JobFactory : JobFactoryBase("a", "b")',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
  });

  it("maps Kotlin supertypes with named constructor arguments", async () => {
    const root = await fixtureRoot("clawpatch-kotlin-supertype-named-arg-");
    await writeFixture(root, "settings.gradle.kts", "pluginManagement {}\n");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("org.jetbrains.kotlin.jvm") }\n');
    await writeFixture(
      root,
      "src/main/kotlin/com/example/jobs/JobFactory.kt",
      [
        "package com.example.jobs",
        "",
        "import org.scheduler.JobFactoryBase",
        "",
        'class JobFactory : JobFactoryBase(name = "jobs")',
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const framework = result.features.find(
      (feature) =>
        feature.source === "kotlin-server-role-framework-component" &&
        feature.ownedFiles.some(
          (file) => file.path === "src/main/kotlin/com/example/jobs/JobFactory.kt",
        ),
    );

    expect(framework?.ownedFiles[0]?.reason).toContain("external type org.scheduler.");
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
      "src/main/java/com/acme/ext/ServletFilter.java",
      [
        "package com.acme.ext;",
        "",
        "import jakarta.servlet.Filter;",
        "",
        "public class ServletFilter implements Filter {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/main/java/com/acme/security/SslFactory.java",
      [
        "package com.acme.security;",
        "",
        "import javax.net.ssl.SSLContext;",
        "",
        "public class SslFactory {",
        "  public SSLContext context() { return null; }",
        "}",
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
        "src/main/java/com/acme/ext/ServletFilter.java",
        "src/main/java/com/acme/jobs/GenericJobFactory.java",
        "src/main/java/com/acme/jobs/JobFactory.java",
      ].toSorted(),
    );
    expect(
      bySource.get("jvm-role-framework-component")?.ownedFiles.map((file) => file.path),
    ).not.toContain("src/main/java/com/acme/security/SslFactory.java");
    expect(
      bySource
        .get("jvm-role-extension-boundary")
        ?.ownedFiles.map((file) => file.path)
        .toSorted(),
    ).toEqual([
      "src/main/java/com/acme/ext/HelperFirstAdapter.java",
      "src/main/java/com/acme/ext/PluginAdapter.java",
      "src/main/java/com/acme/ext/RecordPlugin.java",
      "src/main/java/com/acme/ext/ServletFilter.java",
      "src/main/java/com/acme/local/LocalCommandAdapter.java",
      "src/main/java/com/google/myapp/GuavaAdapter.java",
    ]);
  });

  it("does not treat qualified Java annotations as type imports", async () => {
    const root = await fixtureRoot("clawpatch-java-qualified-annotation-type-map-");
    await writeFixture(root, "build.gradle.kts", 'plugins { id("java") }\n');
    await writeFixture(
      root,
      "src/main/java/com/acme/app/Billing.java",
      [
        "package com.acme.app;",
        "",
        "@org.springframework.stereotype.Service",
        "public class Billing implements Service {}",
        "interface Service {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(
      result.features.some(
        (feature) =>
          feature.source === "jvm-role-framework-component" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/java/com/acme/app/Billing.java",
          ),
      ),
    ).toBe(false);
    expect(
      result.features.some(
        (feature) =>
          feature.source === "jvm-role-application-service" &&
          feature.ownedFiles.some(
            (file) => file.path === "src/main/java/com/acme/app/Billing.java",
          ),
      ),
    ).toBe(true);
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

  it("bounds Rust integration tests attached to entrypoint features", async () => {
    const root = await fixtureRoot("clawpatch-rust-test-bound-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rust-test-bound"\n');
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");
    for (let index = 1; index <= 8; index += 1) {
      await writeFixture(root, `tests/test_${index}.rs`, "#[test]\nfn works() {}\n");
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const library = result.features.find(
      (feature) => feature.title === "Rust library rust-test-bound",
    );
    const integrationTests = result.features.filter(
      (feature) => feature.source === "rust-integration-test",
    );

    expect(library?.tests).toHaveLength(5);
    expect(library?.contextFiles).toHaveLength(5);
    expect(integrationTests).toHaveLength(8);
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
    await writeFixture(root, "tests/myapp_test.cpp", "int main() { return 0; }\n");
    await writeFixture(root, "src/deps/myapp_test.cpp", "int main() { return 0; }\n");

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
      { path: "tests/myapp_test.cpp", reason: "nearby test" },
    ]);
    expect(myapp?.tests).toEqual([{ path: "tests/myapp_test.cpp", command: null }]);
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

  it("does not attach generic main CMake tests to every target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-generic-main-test-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(foo foo/main.c)\nadd_executable(bar bar/main.c)\n",
    );
    await writeFixture(root, "foo/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "bar/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/main_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const foo = result.features.find((feature) => feature.title === "CMake binary foo");
    const bar = result.features.find((feature) => feature.title === "CMake binary bar");

    expect(foo?.tests).toEqual([]);
    expect(bar?.tests).toEqual([]);
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

  it("keeps CMake binaries with helper source names that look test-like", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-like-helper-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c src/test_mode.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/test_mode.c", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake test suite app");
    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/test_mode.c", reason: "target source" },
    ]);
  });

  it("keeps CMake binaries when a test-like helper comes before main", async () => {
    const root = await fixtureRoot("clawpatch-cmake-test-like-helper-before-main-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/test_mode.c src/runner.c)\n",
    );
    await writeFixture(root, "src/test_mode.c", "int helper(void) { return 0; }\n");
    await writeFixture(root, "src/runner.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(titles).not.toContain("CMake test suite app");
    expect(app?.entrypoints[0]?.path).toBe("src/runner.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/test_mode.c", reason: "target source" },
      { path: "src/runner.c", reason: "target source" },
    ]);
  });

  it("attaches CMake tests named after the target", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-named-tests-");
    await writeFixture(root, "CMakeLists.txt", "add_executable(app src/main.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "tests/app_test.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.tests).toEqual([{ path: "tests/app_test.c", command: null }]);
    expect(app?.contextFiles).toContainEqual({ path: "tests/app_test.c", reason: "nearby test" });
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

  it("ignores CMake helper names ending with built-in commands", async () => {
    const root = await fixtureRoot("clawpatch-cmake-helper-command-names-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "my_add_executable(app src/main.c)\nmy_add_library(core src/core.c)\nadd_executable(real src/real.c)\nmy_target_sources(real PRIVATE src/helper.c)\nmy_include(cmake/Extra.cmake)\n",
    );
    await writeFixture(root, "cmake/Extra.cmake", "add_executable(extra src/extra.c)\n");
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 0; }\n");
    await writeFixture(root, "src/helper.c", "int helper(void) { return 0; }\n");
    await writeFixture(root, "src/extra.c", "int extra(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const real = result.features.find((feature) => feature.title === "CMake binary real");
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary app");
    expect(titles).not.toContain("CMake library core");
    expect(titles).not.toContain("CMake binary extra");
    expect(real?.ownedFiles).toEqual([{ path: "src/real.c", reason: "target source" }]);
  });

  it("ignores CMake command text inside strings", async () => {
    const root = await fixtureRoot("clawpatch-cmake-command-string-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      'message("add_executable(fake src/main.c)")\nmessage([[add_library(fake_lib src/lib.c)]])\nadd_executable(real src/real.c)\n',
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("ignores CMake command text inside unquoted command arguments", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-command-text-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "message(STATUS add_executable(fake src/fake.c))\nset(x add_library(fake_lib src/lib.c))\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("ignores CMake commands inside uncalled function and macro bodies", async () => {
    const root = await fixtureRoot("clawpatch-cmake-uncalled-function-body-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "function(make_fake)\nadd_executable(fake src/fake.c)\nendfunction()\nmacro(make_fake_lib)\nadd_library(fake_lib src/lib.c)\nendmacro()\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/lib.c", "int lib(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).not.toContain("CMake library fake_lib");
    expect(titles).toContain("CMake binary real");
  });

  it("keeps CMake targets after bracket arguments containing hashes", async () => {
    const root = await fixtureRoot("clawpatch-cmake-bracket-hash-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "message([[# generated]])\nmessage([=[# also generated]=])\n#[[add_executable(fake src/fake.c)]]\nadd_executable(real src/real.c)\n",
    );
    await writeFixture(root, "src/fake.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/real.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).not.toContain("CMake binary fake");
    expect(titles).toContain("CMake binary real");
    expect(titles).not.toContain("C binary real");
  });

  it("maps quoted CMake source paths containing spaces", async () => {
    const root = await fixtureRoot("clawpatch-cmake-quoted-space-source-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      'add_executable(app "src/main file.cpp" "src/helper file.cpp")\n',
    );
    await writeFixture(root, "src/main file.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/helper file.cpp", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main file.cpp", reason: "target source" },
      { path: "src/helper file.cpp", reason: "target source" },
    ]);
  });

  it("maps escaped CMake source paths containing spaces and semicolons", async () => {
    const root = await fixtureRoot("clawpatch-cmake-escaped-source-path-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "add_executable(app src/main\\ file.cpp src/helper\\;part.cpp)\n",
    );
    await writeFixture(root, "src/main file.cpp", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/helper;part.cpp", "int helper(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.ownedFiles).toEqual([
      { path: "src/main file.cpp", reason: "target source" },
      { path: "src/helper;part.cpp", reason: "target source" },
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
    expect(app?.contextFiles).toEqual([
      { path: "CMakeLists.txt", reason: "CMake target declaration" },
      { path: "src/CMakeLists.txt", reason: "CMake target source declaration" },
    ]);
    expect(titles).not.toContain("C binary main");
  });

  it("resolves PROJECT_NAME CMake targets", async () => {
    const root = await fixtureRoot("clawpatch-cmake-project-name-target-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(app C)\nadd_executable(${PROJECT_NAME})\ntarget_sources(${PROJECT_NAME} PRIVATE src/main.c src/util.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
    ]);
  });

  it("resolves PROJECT_NAME inside composed CMake target names", async () => {
    const root = await fixtureRoot("clawpatch-cmake-composed-project-name-target-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "project(foo C)\nadd_executable(${PROJECT_NAME}_cli src/main.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary foo_cli");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "foo_cli" });
    expect(app?.ownedFiles).toEqual([{ path: "src/main.c", reason: "target source" }]);
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

  it("prefers exact target-name source stems before prefix matches", async () => {
    const root = await fixtureRoot("clawpatch-cmake-target-stem-entry-");
    await writeFixture(root, "CMakeLists.txt", "add_library(app src/apple.c src/app.c)\n");
    await writeFixture(root, "src/apple.c", "int apple(void) { return 1; }\n");
    await writeFixture(root, "src/app.c", "int app(void) { return 1; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake library app");

    expect(app?.entrypoints[0]?.path).toBe("src/app.c");
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

  it("resolves built-in CMake dir variables in includes and sources", async () => {
    const root = await fixtureRoot("clawpatch-cmake-built-in-dir-vars-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "include(${CMAKE_CURRENT_SOURCE_DIR}/cmake/Targets.cmake)\n",
    );
    await writeFixture(
      root,
      "cmake/Targets.cmake",
      "include(${CMAKE_CURRENT_LIST_DIR}/More.cmake)\nadd_executable(app ${CMAKE_SOURCE_DIR}/src/main.c ${PROJECT_SOURCE_DIR}/src/project.c ${CMAKE_CURRENT_SOURCE_DIR}/src/util.c ${CMAKE_CURRENT_LIST_DIR}/local.c)\n",
    );
    await writeFixture(
      root,
      "cmake/More.cmake",
      "target_sources(app PRIVATE ${CMAKE_CURRENT_LIST_DIR}/extra.c)\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/project.c", "int project(void) { return 0; }\n");
    await writeFixture(root, "src/util.c", "int util(void) { return 0; }\n");
    await writeFixture(root, "cmake/local.c", "int local(void) { return 0; }\n");
    await writeFixture(root, "cmake/extra.c", "int extra(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "CMake binary app");

    expect(app?.entrypoints[0]?.path).toBe("src/main.c");
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "src/project.c", reason: "target source" },
      { path: "src/util.c", reason: "target source" },
      { path: "cmake/local.c", reason: "target source" },
      { path: "cmake/extra.c", reason: "target source" },
    ]);
  });

  it("resolves CMake source dir variables from nested project roots", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-project-vars-");
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "add_executable(project_app ${PROJECT_SOURCE_DIR}/src/project.c)\nadd_executable(source_app ${CMAKE_SOURCE_DIR}/src/source.c)\n",
    );
    await writeFixture(root, "src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/source.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/source.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const projectApp = result.features.find(
      (feature) => feature.title === "CMake binary project_app",
    );
    const sourceApp = result.features.find(
      (feature) => feature.title === "CMake binary source_app",
    );

    expect(projectApp?.entrypoints[0]?.path).toBe("sub/src/project.c");
    expect(sourceApp?.entrypoints[0]?.path).toBe("sub/src/source.c");
  });

  it("resets PROJECT_SOURCE_DIR when nested CMakeLists declares project", async () => {
    const root = await fixtureRoot("clawpatch-cmake-nested-project-source-dir-");
    await writeFixture(
      root,
      "CMakeLists.txt",
      "cmake_minimum_required(VERSION 3.20)\nproject(Root C)\nadd_subdirectory(sub)\n",
    );
    await writeFixture(
      root,
      "sub/CMakeLists.txt",
      "project(Sub C)\nadd_executable(project_app ${PROJECT_SOURCE_DIR}/src/project.c)\nadd_executable(source_app ${CMAKE_SOURCE_DIR}/src/source.c)\n",
    );
    await writeFixture(root, "src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/source.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/project.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "sub/src/source.c", "int main(void) { return 0; }\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const projectApp = result.features.find(
      (feature) => feature.title === "CMake binary project_app",
    );
    const sourceApp = result.features.find(
      (feature) =>
        feature.title === "CMake binary source_app" &&
        feature.entrypoints[0]?.path === "src/source.c",
    );
    const sourceAppPaths = result.features
      .filter((feature) => feature.title === "CMake binary source_app")
      .map((feature) => feature.entrypoints[0]?.path);

    expect(projectApp?.entrypoints[0]?.path).toBe("sub/src/project.c");
    expect(sourceApp?.entrypoints[0]?.path).toBe("src/source.c");
    expect(sourceAppPaths).toEqual(["src/source.c"]);
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

  it("maps autotools sources with source-directory variables", async () => {
    const root = await fixtureRoot("clawpatch-autotools-srcdir-sources-");
    await writeFixture(
      root,
      "src/Makefile.am",
      "bin_PROGRAMS = app\napp_SOURCES = $(srcdir)/main.c $(top_srcdir)/shared/util.c\nlib_LTLIBRARIES = libcore.la\nlibcore_la_SOURCES = ${srcdir}/core.c @top_srcdir@/include/core.h\n",
    );
    await writeFixture(root, "src/main.c", "int main(void) { return 0; }\n");
    await writeFixture(root, "src/core.c", "int core(void) { return 1; }\n");
    await writeFixture(root, "shared/util.c", "int util(void) { return 1; }\n");
    await writeFixture(root, "include/core.h", "int core(void);\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const app = result.features.find((feature) => feature.title === "Autotools binary app");
    const core = result.features.find((feature) => feature.title === "Autotools library libcore");

    expect(app?.entrypoints[0]).toMatchObject({ path: "src/main.c", command: "app" });
    expect(app?.ownedFiles).toEqual([
      { path: "src/main.c", reason: "target source" },
      { path: "shared/util.c", reason: "target source" },
    ]);
    expect(core?.ownedFiles).toEqual([
      { path: "src/core.c", reason: "target source" },
      { path: "include/core.h", reason: "target source" },
    ]);
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

  it("detects C and C++ main functions after comments containing quotes", async () => {
    const root = await fixtureRoot("clawpatch-cpp-comment-quotes-");
    await writeFixture(
      root,
      "src/app.cpp",
      '// TODO parse "flag\n/* disabled "quoted" branch */\nint main(void) { return 0; }\n',
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

  it("detects non-C and C++ languages under vendor path components", async () => {
    const root = await fixtureRoot("clawpatch-vendor-language-detect-");
    await writeFixture(root, "src/vendor/worker.py", "def main():\n    pass\n");
    await writeFixture(root, "src/pkg/vendor/app.py", "def main():\n    pass\n");
    await writeFixture(root, "src/main/vendor/App.java", "class App {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toEqual(expect.arrayContaining(["python", "java"]));
  });

  it("ignores top-level vendored native project metadata during detection", async () => {
    const root = await fixtureRoot("clawpatch-top-vendor-native-detect-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "host" }, null, 2));
    await writeFixture(
      root,
      "vendor/Dependency/Package.swift",
      'import PackageDescription\nlet package = Package(name: "Dependency")\n',
    );
    await writeFixture(root, "vendor/Dependency/build.gradle.kts", 'plugins { id("java") }\n');

    const project = await detectProject(root);

    expect(project.detected.languages).not.toContain("swift");
    expect(project.detected.packageManagers).not.toContain("swiftpm");
    expect(project.detected.packageManagers).not.toContain("gradle");
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

  it("detects and maps Laravel application slices", async () => {
    const root = await fixtureRoot("clawpatch-laravel-map-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/wault",
          type: "project",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "laravel/pint": "^1.0",
            "phpunit/phpunit": "^12.0",
          },
          scripts: {
            test: ["@php artisan config:clear --ansi", "@php artisan test"],
            "deploy:production:manual": "bash deploy/bin/deploy.sh",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "artisan", "#!/usr/bin/env php\n");
    await writeFixture(root, "phpunit.xml", "<phpunit />\n");
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\LandingPageController;\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/', LandingPageController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n" +
        "Route::resource('catalog', TrackController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/TrackController.php",
      "<?php\nnamespace App\\Http\\Controllers;\n" +
        "use App\\Http\\Requests\\StoreTrackRequest;\n" +
        "use App\\Services\\TrackUploadService;\n" +
        "final class TrackController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/LandingPageController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class LandingPageController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Requests/StoreTrackRequest.php",
      "<?php\nnamespace App\\Http\\Requests;\nfinal class StoreTrackRequest {}\n",
    );
    await writeFixture(
      root,
      "app/Services/TrackUploadService.php",
      "<?php\nnamespace App\\Services;\nfinal class TrackUploadService {}\n",
    );
    await writeFixture(
      root,
      "app/Jobs/RunSubmissionAnalysis.php",
      "<?php\nnamespace App\\Jobs;\nfinal class RunSubmissionAnalysis {}\n",
    );
    await writeFixture(
      root,
      "app/Console/Commands/ReleaseCut.php",
      "<?php\nnamespace App\\Console\\Commands;\nfinal class ReleaseCut { protected $signature = 'app:release-cut {version}'; }\n",
    );
    await writeFixture(
      root,
      "app/Console/Commands/ReportCatalogWatermarks.php",
      "<?php\nnamespace App\\Console\\Commands;\nuse Illuminate\\Console\\Attributes\\Signature;\n#[Signature('app:report-catalog-watermarks\n    {--json : Output JSON}')] final class ReportCatalogWatermarks {}\n",
    );
    await writeFixture(
      root,
      "app/Models/Track.php",
      "<?php\nnamespace App\\Models;\nfinal class Track {}\n",
    );
    await writeFixture(
      root,
      "database/migrations/2026_01_01_000000_create_tracks_table.php",
      "<?php\nreturn new class {};\n",
    );
    await writeFixture(
      root,
      "tests/Feature/TrackControllerTest.php",
      "<?php\nit('stores tracks', function () {});\n",
    );
    await writeFixture(
      root,
      "tests/Unit/TrackUploadServiceTest.php",
      "<?php\nit('uploads tracks', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const trackController = result.features.find(
      (feature) => feature.title === "Laravel controller TrackController",
    );
    const service = result.features.find(
      (feature) => feature.title === "Laravel service TrackUploadService",
    );

    expect(project.detected.languages).toContain("php");
    expect(project.detected.frameworks).toContain("laravel");
    expect(project.detected.packageManagers).toContain("composer");
    expect(project.detected.commands.test).toBe("composer test");
    expect(project.detected.commands.lint).toBe("vendor/bin/pint --test");
    expect(titles).toContain("Laravel project wault");
    expect(titles).toContain("Composer script test");
    expect(titles).toContain("Composer script deploy:production:manual");
    expect(titles).toContain("Laravel controller TrackController");
    expect(titles).toContain("Laravel controller LandingPageController");
    expect(titles).toContain("Laravel request StoreTrackRequest");
    expect(titles).toContain("Laravel command app:release-cut");
    expect(titles).toContain("Laravel command app:report-catalog-watermarks");
    expect(titles).toContain("Laravel job RunSubmissionAnalysis");
    expect(titles).toContain("Laravel service TrackUploadService");
    expect(titles).toContain("Laravel model Track");
    expect(titles).toContain("Laravel migrations database/migrations");
    expect(titles).toContain("Laravel test suite tests/Feature");
    expect(titles).toContain("Project config composer.json");
    expect(trackController?.entrypoints[0]?.route).toBe("/tracks");
    expect(trackController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
    expect(trackController?.contextFiles).toContainEqual({
      path: "app/Http/Requests/StoreTrackRequest.php",
      reason: "imported application class",
    });
    expect(trackController?.tests).toEqual([
      { path: "tests/Feature/TrackControllerTest.php", command: "composer test" },
    ]);
    expect(service?.tests).toEqual([
      { path: "tests/Unit/TrackUploadServiceTest.php", command: "composer test" },
    ]);
  });

  it("keeps Laravel routes scoped to same-basename controller namespaces", async () => {
    const root = await fixtureRoot("clawpatch-laravel-controller-namespaces-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/namespaced-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/admin.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Admin\\{UserController};\n" +
        "Route::prefix('admin')->middleware('auth')->get('/users', UserController::class);\n",
    );
    await writeFixture(
      root,
      "routes/api.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Api\\UserController;\n" +
        "Route::get('/users', UserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Admin/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Admin;\nfinal class UserController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const adminController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Admin/UserController.php",
    );
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(adminController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(adminController?.contextFiles).toContainEqual({
      path: "routes/admin.php",
      reason: "route definition",
    });
    expect(adminController?.contextFiles).not.toContainEqual({
      path: "routes/api.php",
      reason: "route definition",
    });
    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
    expect(apiController?.contextFiles).toContainEqual({
      path: "routes/api.php",
      reason: "route definition",
    });
    expect(apiController?.contextFiles).not.toContainEqual({
      path: "routes/admin.php",
      reason: "route definition",
    });
  });

  it("maps fully qualified Laravel controller route references", async () => {
    const root = await fixtureRoot("clawpatch-laravel-qualified-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/qualified-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "Route::get('/qualified', \\App\\Http\\Controllers\\QualifiedController::class);\n" +
        "Route::post('/qualified-array', [App\\Http\\Controllers\\ArrayQualifiedController::class, 'store']);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/QualifiedController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class QualifiedController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/ArrayQualifiedController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class ArrayQualifiedController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const qualifiedController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/QualifiedController.php",
    );
    const arrayQualifiedController = result.features.find(
      (feature) =>
        feature.entrypoints[0]?.path === "app/Http/Controllers/ArrayQualifiedController.php",
    );

    expect(qualifiedController?.entrypoints[0]?.route).toBe("/qualified");
    expect(qualifiedController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
    expect(arrayQualifiedController?.entrypoints[0]?.route).toBe("/qualified-array");
    expect(arrayQualifiedController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps aliased Laravel controller route imports", async () => {
    const root = await fixtureRoot("clawpatch-laravel-aliased-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/aliased-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Admin\\UserController as AdminUserController;\n" +
        "use App\\Http\\Controllers\\Api\\UserController as ApiUserController;\n" +
        "Route::get('/admin/users', AdminUserController::class);\n" +
        "Route::get('/api/users', ApiUserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Admin/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Admin;\nfinal class UserController {}\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const adminController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Admin/UserController.php",
    );
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(adminController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
  });

  it("maps namespace-imported Laravel controller route references", async () => {
    const root = await fixtureRoot("clawpatch-laravel-namespace-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/namespace-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\Api;\n" +
        "Route::get('/api/users', Api\\UserController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/Api/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers\\Api;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const apiController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/Api/UserController.php",
    );

    expect(apiController?.entrypoints[0]?.route).toBe("/api/users");
    expect(apiController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps parameterized Laravel fluent route prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-parameterized-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/parameterized-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\DashboardController;\n" +
        "Route::prefix('{tenant}')->get('/dashboard', DashboardController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/DashboardController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class DashboardController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const dashboard = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/DashboardController.php",
    );

    expect(dashboard?.entrypoints[0]?.route).toBe("/{tenant}/dashboard");
  });

  it("maps Laravel array-style route group prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-array-group-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/array-group-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        'Route::group(["prefix" => "admin"], function () {\n' +
        '    Route::get("/users", UserController::class);\n' +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users");
    expect(userController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("maps nested Laravel route groups inside array-style prefixes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-nested-array-group-prefix-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/nested-array-group-prefix",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::group(['prefix' => 'admin'], function () {\n" +
        "    Route::controller(UserController::class)->group(function () {\n" +
        "        Route::get('/users', 'index');\n" +
        "    });\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users#index");
  });

  it("maps Laravel prefixes nested inside non-prefix array groups", async () => {
    const root = await fixtureRoot("clawpatch-laravel-non-prefix-array-group-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/non-prefix-array-group",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::group(['middleware' => 'auth'], function () {\n" +
        "    Route::group(['prefix' => 'admin'], function () {\n" +
        "        Route::get('/users', UserController::class);\n" +
        "    });\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users");
  });

  it("maps Laravel controller route groups", async () => {
    const root = await fixtureRoot("clawpatch-laravel-controller-groups-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/controller-groups",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\UserController;\n" +
        "Route::prefix('admin')->controller(UserController::class)->group(function () {\n" +
        "    Route::get('/users', 'index');\n" +
        "    Route::post('/users', 'store');\n" +
        "});\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/UserController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class UserController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const userController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/UserController.php",
    );

    expect(userController?.entrypoints[0]?.route).toBe("/admin/users");
    expect(userController?.summary).toContain("GET /admin/users#index");
    expect(userController?.summary).toContain("POST /admin/users#store");
    expect(userController?.contextFiles).toContainEqual({
      path: "routes/web.php",
      reason: "route definition",
    });
  });

  it("keeps Laravel controller feature IDs stable when first route changes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-stable-controller-id-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/stable-controller-id",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "app/Http/Controllers/TrackController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class TrackController {}\n",
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/tracks', TrackController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n",
    );

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstController = first.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/TrackController.php",
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\TrackController;\n" +
        "Route::get('/catalog/tracks', TrackController::class);\n" +
        "Route::get('/tracks', TrackController::class);\n" +
        "Route::post('/tracks', [TrackController::class, 'store']);\n",
    );

    const second = await mapFeatures(root, project, []);
    const secondController = second.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/TrackController.php",
    );

    expect(firstController?.featureId).toBeDefined();
    expect(secondController?.featureId).toBe(firstController?.featureId);
    expect(secondController?.entrypoints[0]?.route).toBe("/catalog/tracks");
  });

  it("ignores commented-out Laravel routes", async () => {
    const root = await fixtureRoot("clawpatch-laravel-commented-routes-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/commented-routes",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "routes/web.php",
      "<?php\n" +
        "use App\\Http\\Controllers\\ArchiveController;\n" +
        "// Route::get('/old', ArchiveController::class);\n" +
        "/*\nRoute::get('/blocked', ArchiveController::class);\n*/\n" +
        "Route::get('/current', ArchiveController::class);\n",
    );
    await writeFixture(
      root,
      "app/Http/Controllers/ArchiveController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class ArchiveController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const archiveController = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/ArchiveController.php",
    );

    expect(archiveController?.entrypoints[0]?.route).toBe("/current");
    expect(archiveController?.summary).toContain("GET /current");
    expect(archiveController?.summary).not.toContain("/old");
    expect(archiveController?.summary).not.toContain("/blocked");
  });

  it("ignores commented-out Laravel command signatures", async () => {
    const root = await fixtureRoot("clawpatch-laravel-commented-command-signature-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/commented-command-signature",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "artisan", "#!/usr/bin/env php\n");
    await writeFixture(
      root,
      "app/Console/Commands/SyncCatalog.php",
      "<?php\nnamespace App\\Console\\Commands;\n" +
        "// protected $signature = 'app:old-sync';\n" +
        "/* #[Signature('app:blocked-sync')] */\n" +
        "final class SyncCatalog { protected $signature = 'app:sync-catalog {--force}'; }\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const command = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Console/Commands/SyncCatalog.php",
    );

    expect(titles).toContain("Laravel command app:sync-catalog");
    expect(titles).not.toContain("Laravel command app:old-sync");
    expect(titles).not.toContain("Laravel command app:blocked-sync");
    expect(command?.entrypoints[0]?.command).toBe("app:sync-catalog");
  });

  it("uses Composer validation scripts for PHP projects", async () => {
    const root = await fixtureRoot("clawpatch-php-composer-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/php-tool",
          require: {
            php: "^8.3",
          },
          scripts: {
            typecheck: "vendor/bin/phpstan analyse --level=max",
            analyse: "vendor/bin/phpstan analyse",
            lint: "vendor/bin/phpcs",
            format: "vendor/bin/php-cs-fixer fix --dry-run",
            test: "vendor/bin/phpunit",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "app/Service.php", "<?php\nfinal class Service {}\n");
    await writeFixture(root, "tests/LibTest.php", "<?php\nfinal class LibTest {}\n");
    await writeFixture(root, "tests/OtherTest.php", "<?php\nfinal class OtherTest {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const phpTestSuite = result.features.find((feature) =>
      feature.title.startsWith("PHP test suite tests"),
    );

    expect(project.detected.commands).toEqual({
      typecheck: "composer typecheck",
      lint: "composer lint",
      format: "composer format",
      test: "composer test",
    });
    expect(titles).toContain("Composer script test");
    expect(titles).toContain("Composer script typecheck");
    expect(phpTestSuite?.title).toBe("PHP test suite tests");
    expect(phpTestSuite?.tags).toEqual(["php", "test"]);
    expect(phpTestSuite?.tests.map((test) => test.path).toSorted()).toEqual([
      "tests/LibTest.php",
      "tests/OtherTest.php",
    ]);
    expect(titles).not.toContain("Laravel project php-tool");
  });

  it("uses PHPUnit for Laravel package projects without artisan", async () => {
    const root = await fixtureRoot("clawpatch-laravel-package-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/laravel-package",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "phpunit/phpunit": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "phpunit.xml", "<phpunit />\n");
    await writeFixture(root, "src/PackageServiceProvider.php", "<?php\nfinal class Provider {}\n");

    expect((await detectProject(root)).detected.commands.test).toBe("vendor/bin/phpunit");
  });

  it("uses Pest and PHPStan defaults for PHP packages", async () => {
    const root = await fixtureRoot("clawpatch-php-quality-commands-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/php-quality",
          require: {
            php: "^8.3",
          },
          "require-dev": {
            "pestphp/pest": "^3.0",
            "phpstan/phpstan": "^2.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(root, "src/PackageService.php", "<?php\nfinal class PackageService {}\n");
    await writeFixture(
      root,
      "tests/PackageServiceTest.php",
      "<?php\nit('works', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const phpTestSuite = result.features.find((feature) =>
      feature.title.startsWith("PHP test suite tests"),
    );

    expect(project.detected.commands).toMatchObject({
      typecheck: "vendor/bin/phpstan analyse",
      test: "vendor/bin/pest",
    });
    expect(phpTestSuite?.tests).toEqual([
      { path: "tests/PackageServiceTest.php", command: "vendor/bin/pest" },
    ]);
  });

  it("uses PHPUnit dependency test commands for Laravel package features", async () => {
    const root = await fixtureRoot("clawpatch-laravel-package-feature-tests-");
    await writeFixture(
      root,
      "composer.json",
      JSON.stringify(
        {
          name: "acme/laravel-package-features",
          require: {
            php: "^8.3",
            "laravel/framework": "^13.0",
          },
          "require-dev": {
            "phpunit/phpunit": "^12.0",
          },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "app/Http/Controllers/PackageController.php",
      "<?php\nnamespace App\\Http\\Controllers;\nfinal class PackageController {}\n",
    );
    await writeFixture(
      root,
      "tests/Feature/PackageControllerTest.php",
      "<?php\nit('handles package routes', function () {});\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const controller = result.features.find(
      (feature) => feature.entrypoints[0]?.path === "app/Http/Controllers/PackageController.php",
    );

    expect(project.detected.commands.test).toBe("vendor/bin/phpunit");
    expect(controller?.tests).toEqual([
      { path: "tests/Feature/PackageControllerTest.php", command: "vendor/bin/phpunit" },
    ]);
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

  it("maps Django urls.py routes conservatively", async () => {
    const root = await fixtureRoot("clawpatch-python-django-routes-");
    await writeFixture(root, "requirements.txt", "django\npytest\n");
    await writeFixture(root, "mysite/__init__.py", "");
    await writeFixture(
      root,
      "mysite/urls.py",
      [
        "from django.conf.urls import url",
        "from django.urls import include, path, re_path",
        "from django.contrib import admin",
        "from . import views",
        "from .views import SignupView",
        "",
        '"""',
        "urlpatterns = [",
        "    path('docs-only/', views.docs_only),",
        "]",
        '"""',
        "",
        'r"""',
        "urlpatterns = [",
        "    path('raw-docs-only/', views.raw_docs_only),",
        "]",
        '"""',
        "",
        "def build_local_patterns():",
        "    '''",
        "    urlpatterns = [",
        "        path('indented-docs-only/', views.indented_docs_only),",
        "    ]",
        "    '''",
        "    urlpatterns = [",
        "        path('local-only/', views.local_only),",
        "    ]",
        "    return urlpatterns",
        "",
        "def helper_patterns():",
        "    return [",
        "        path('helper/', views.helper),",
        "    ]",
        "",
        "unused_patterns = [",
        "    path('unused/', views.unused),",
        "]",
        "",
        "urlpatterns = [path('inline/', views.inline), re_path(r'^inline-regex/$', views.inline_regex),",
        "    path('', views.index, name='index'),",
        "    path('users/<int:pk>/', views.user_detail, name='user-detail'),",
        "    path('accounts/password/reset/', views.password_reset, name='password-reset'),",
        "    path('orders/', views.orders, name='orders'),",
        "    path(",
        "        'reports/',",
        "        views.reports,",
        "        name='reports',",
        "    ),",
        "    path('signup/', SignupView.as_view(), name='signup'),",
        "    path('admin/', admin.site.urls),",
        "    path('api/', include('api.urls')),",
        "    path('tuple-api/', include(('tuple.urls', 'tuple'), namespace='tuple')),",
        "    re_path(r'^legacy/(?P<slug>[-\\w]+)/$', views.legacy, name='legacy'),",
        "    url(r'^old/(?P<pk>\\d+)/$', views.old_detail),",
        "    path(DYNAMIC_ROUTE, views.dynamic),",
        "    path(f'tenant/{slug}/', views.dynamic),",
        "    re_path(r'^(foo|bar)/$', views.complex_regex),",
        "    custom_path('custom/', views.custom),",
        "    # path('commented/', views.commented),",
        "    \"path('string/', views.string)\",",
        "]",
        "urlpatterns += [path('extra/', views.extra)]",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "fallback/__init__.py", "");
    await writeFixture(
      root,
      "fallback/urls.py",
      [
        "from . import views",
        "",
        "urlpatterns = [",
        "    path('dependency-only/', views.dependency_only),",
        "]",
        "",
      ].join("\n"),
    );
    await writeFixture(root, "mysite/views.py", "class SignupView:\n    pass\n");
    await writeFixture(root, "fallback/views.py", "def dependency_only():\n    pass\n");
    await writeFixture(root, "mysite/test_urls.py", "def test_urls():\n    pass\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const routes = result.features.filter((feature) => feature.source === "python-django-route");
    const titles = routes.map((feature) => feature.title);
    const byTitle = (title: string) => routes.find((feature) => feature.title === title);

    expect(project.detected.frameworks).toContain("django");
    expect(titles).toEqual(
      expect.arrayContaining([
        "Django route /",
        "Django route /users/:pk/",
        "Django route /accounts/password/reset/",
        "Django route /orders/",
        "Django route /reports/",
        "Django route /signup/",
        "Django route /admin/",
        "Django route /api/",
        "Django route /tuple-api/",
        "Django route /dependency-only/",
        "Django route /legacy/:slug/",
        "Django route /old/:pk/",
        "Django route /inline/",
        "Django route /inline-regex/",
        "Django route /extra/",
      ]),
    );
    expect(byTitle("Django route /")?.entrypoints[0]).toMatchObject({
      path: "mysite/urls.py",
      symbol: "views.index",
      route: "/",
    });
    expect(byTitle("Django route /")?.tests).toEqual([
      { path: "mysite/test_urls.py", command: "pytest" },
    ]);
    expect(byTitle("Django route /api/")?.entrypoints[0]?.symbol).toBe("api.urls");
    expect(byTitle("Django route /tuple-api/")?.entrypoints[0]?.symbol).toBeNull();
    expect(byTitle("Django route /signup/")?.entrypoints[0]?.symbol).toBe("SignupView.as_view");
    expect(byTitle("Django route /admin/")?.entrypoints[0]?.symbol).toBe("admin.site.urls");
    expect(byTitle("Django route /dependency-only/")?.entrypoints[0]).toMatchObject({
      path: "fallback/urls.py",
      symbol: "views.dependency_only",
      route: "/dependency-only/",
    });
    expect(byTitle("Django route /accounts/password/reset/")?.trustBoundaries).toContain("auth");
    expect(byTitle("Django route /signup/")?.trustBoundaries).toContain("auth");
    expect(byTitle("Django route /users/:pk/")?.trustBoundaries).not.toContain("auth");
    expect(byTitle("Django route /orders/")?.trustBoundaries).not.toContain("auth");
    expect(titles).not.toContain("Django route /tenant/");
    expect(titles).not.toContain("Django route /custom/");
    expect(titles).not.toContain("Django route /commented/");
    expect(titles).not.toContain("Django route /string/");
    expect(titles).not.toContain("Django route /(foo|bar)/");
    expect(titles).not.toContain("Django route /docs-only/");
    expect(titles).not.toContain("Django route /raw-docs-only/");
    expect(titles).not.toContain("Django route /indented-docs-only/");
    expect(titles).not.toContain("Django route /local-only/");
    expect(titles).not.toContain("Django route /helper/");
    expect(titles).not.toContain("Django route /unused/");
  });

  it("does not map Django-shaped URLs without a Django signal", async () => {
    const root = await fixtureRoot("clawpatch-python-django-url-false-positive-");
    await writeFixture(root, "requirements.txt", "pytest\n");
    await writeFixture(root, "web/__init__.py", "");
    await writeFixture(
      root,
      "web/urls.py",
      [
        'r"""from django.urls import path"""',
        "",
        "def path(route, handler):",
        "    return (route, handler)",
        "",
        "urlpatterns = [",
        "    path('not-django/', handler),",
        "]",
        "def handler():",
        "    pass",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);

    expect(project.detected.frameworks).not.toContain("django");
    expect(result.features.some((feature) => feature.source === "python-django-route")).toBe(false);
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
  it("detects Mix and Phoenix projects with useful default commands", async () => {
    const root = await fixtureRoot("clawpatch-elixir-detect-");
    await writeFixture(
      root,
      "mix.exs",
      `defmodule SampleApp.MixProject do
  use Mix.Project

  def project do
    [
      # app: :wrong_app,
      app: :sample_app,
      version: "0.1.0",
      elixir: "~> 1.18",
      deps: deps()
    ]
  end

  defp deps do
    [
      # {:ecto_sql, "~> 3.13"},
      {:phoenix, "~> 1.8"},
      {:phoenix_live_view, "~> 1.1"},
      {:credo, "~> 1.7", only: [:dev, :test], runtime: false}
    ]
  end
end
`,
    );

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("elixir");
    expect(project.detected.frameworks).toEqual(expect.arrayContaining(["mix", "phoenix"]));
    expect(project.detected.frameworks).not.toContain("ecto_sql");
    expect(project.detected.packageManagers).toContain("mix");
    expect(project.detected.commands).toEqual({
      typecheck: "mix compile --warnings-as-errors",
      lint: "mix credo --strict",
      format: "mix format --check-formatted",
      test: "mix test",
    });
  });

  it("maps Elixir contexts, Phoenix web slices, config, migrations, and scripts", async () => {
    const root = await fixtureRoot("clawpatch-elixir-map-");
    await writeFixture(
      root,
      "mix.exs",
      `defmodule SampleApp.MixProject do
  use Mix.Project

  def project do
    [
      # app: :wrong_app,
      app: :sample_app,
      version: "0.1.0",
      deps: deps()
    ]
  end

  defp deps do
    [{:phoenix, "~> 1.8"}, {:ecto_sql, "~> 3.13"}]
  end
end
`,
    );
    await writeFixture(root, "config/config.exs", "import Config\n");
    await writeFixture(
      root,
      "priv/repo/migrations/20260517000000_create_users.exs",
      "defmodule SampleApp.Repo.Migrations.CreateUsers do\nend\n",
    );
    await writeFixture(root, "lib/sample_app/repo.ex", "defmodule SampleApp.Repo do\nend\n");
    await writeFixture(
      root,
      "lib/sample_app/accounts.ex",
      "defmodule SampleApp.Accounts do\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app/accounts/user.ex",
      "defmodule SampleApp.Accounts.User do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app/accounts_test.exs",
      "defmodule SampleApp.AccountsTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(root, "lib/sample_app/billing.ex", "defmodule SampleApp.Billing do\nend\n");
    await writeFixture(
      root,
      "test/sample_app/billing_test.exs",
      "defmodule SampleApp.BillingTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/router.ex",
      "defmodule SampleAppWeb.Router do\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/controllers/page_controller.ex",
      "defmodule SampleAppWeb.PageController do\nend\n",
    );
    await writeFixture(
      root,
      "test/sample_app_web/controllers/page_controller_test.exs",
      "defmodule SampleAppWeb.PageControllerTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/live/dashboard_live.ex",
      "defmodule SampleAppWeb.DashboardLive do\nend\n",
    );
    await writeFixture(root, "lib/sample_app_web/live/page_live.html.heex", "<div />\n");
    await writeFixture(
      root,
      "test/sample_app_web/live/page_live_test.exs",
      "defmodule SampleAppWeb.PageLiveTest do\nuse ExUnit.Case\nend\n",
    );
    await writeFixture(
      root,
      "lib/sample_app_web/components/layouts.ex",
      "defmodule SampleAppWeb.Layouts do\nend\n",
    );
    await writeFixture(root, "scripts/release_check.exs", "Mix.install([])\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const accounts = result.features.find((feature) => feature.title === "Elixir context accounts");
    const billing = result.features.find((feature) => feature.title === "Elixir context billing");
    const controllers = result.features.find(
      (feature) => feature.title === "Phoenix web controllers",
    );
    const live = result.features.find((feature) => feature.title === "Phoenix web live");
    const migrations = result.features.find((feature) => feature.title === "Ecto migrations");

    expect(titles).toEqual(
      expect.arrayContaining([
        "Elixir context accounts",
        "Elixir context billing",
        "Phoenix web controllers",
        "Phoenix web live",
        "Phoenix web components",
        "Elixir runtime configuration",
        "Ecto migrations",
        "Project scripts",
      ]),
    );
    expect(accounts?.ownedFiles.map((file) => file.path)).toEqual([
      "lib/sample_app/accounts.ex",
      "lib/sample_app/accounts/user.ex",
    ]);
    expect(accounts?.tests).toEqual([
      {
        path: "test/sample_app/accounts_test.exs",
        command: "mix test test/sample_app/accounts_test.exs",
      },
    ]);
    expect(billing?.ownedFiles.map((file) => file.path)).toEqual(["lib/sample_app/billing.ex"]);
    expect(billing?.tests).toEqual([
      {
        path: "test/sample_app/billing_test.exs",
        command: "mix test test/sample_app/billing_test.exs",
      },
    ]);
    expect(controllers?.contextFiles.map((file) => file.path)).toContain(
      "lib/sample_app_web/router.ex",
    );
    expect(controllers?.tests).toEqual([
      {
        path: "test/sample_app_web/controllers/page_controller_test.exs",
        command: "mix test test/sample_app_web/controllers/page_controller_test.exs",
      },
    ]);
    expect(live?.tests).toContainEqual({
      path: "test/sample_app_web/live/page_live_test.exs",
      command: "mix test test/sample_app_web/live/page_live_test.exs",
    });
    expect(migrations?.contextFiles.map((file) => file.path)).toEqual([
      "mix.exs",
      "lib/sample_app/repo.ex",
    ]);
  });

  it("does not map generated Mix dependency C files", async () => {
    const root = await fixtureRoot("clawpatch-elixir-deps-skip-");
    await writeFixture(
      root,
      "mix.exs",
      'defmodule SampleApp.MixProject do\n  use Mix.Project\n  def project, do: [app: :sample_app, version: "0.1.0"]\nend\n',
    );
    await writeFixture(root, "lib/sample_app/core.ex", "defmodule SampleApp.Core do\nend\n");
    await writeFixture(root, "deps/native/src/noise.c", "int main(void) { return 0; }\n");
    await writeFixture(
      root,
      "apps/web/deps/native/src/nested_noise.c",
      "int main(void) { return 0; }\n",
    );

    const result = await mapFeatures(root, await detectProject(root), []);

    expect(result.features.map((feature) => feature.entrypoints[0]?.path)).toEqual(
      expect.not.arrayContaining([
        "deps/native/src/noise.c",
        "apps/web/deps/native/src/nested_noise.c",
      ]),
    );
  });

  it("still maps non-Elixir source directories named deps", async () => {
    const root = await fixtureRoot("clawpatch-deps-source-dir-");
    await writeFixture(root, "package.json", JSON.stringify({ name: "deps-source" }));
    await writeFixture(root, "lib/deps/client.ts", "export function client() { return true; }\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const owned = result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path));

    expect(owned).toContain("lib/deps/client.ts");
  });

  it("maps C# .NET projects, ASP.NET endpoints, and associated test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-map-");
    await writeFixture(
      root,
      "TodoApp.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "Todo.Api", "src\\Todo.Api\\Todo.Api.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Todo.Api.Tests", "tests\\Todo.Api.Tests\\Todo.Api.Tests.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
`,
    );
    await writeFixture(root, "global.json", '{ "sdk": { "version": "9.0.100" } }\n');
    await writeFixture(root, "Directory.Build.props", "<Project />\n");
    await writeFixture(
      root,
      "src/Todo.Api/Todo.Api.csproj",
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Program.cs",
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGet("/health", () => Results.Ok());
app.MapGet("/todos", () => Results.Ok());
app.MapPost("/todos", (Todo todo) => Results.Created($"/todos/{todo.Id}", todo));
app.MapFallbackToFile("index.html");
app.MapFallbackToFile("/{*path:nonfile}", "index.html");
app.Run();
public sealed record Todo(string Id);
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Controllers/TodoController.cs",
      `using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public sealed class TodoController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(string id) => Ok(id);

    [HttpGet(Name = "ListTodos")]
    public IActionResult List() => Ok();

    [HttpPost]
    public IActionResult Create() => Created();
}
`,
    );
    await writeFixture(
      root,
      "src/Todo.Api/Services/TodoService.cs",
      "public sealed class TodoService {}\n",
    );
    await writeFixture(
      root,
      "src/Todo.Api/Generated/TodoClient.g.cs",
      "public sealed class GeneratedClient {}\n",
    );
    await writeFixture(
      root,
      "src/Todo.Api/obj/Debug/net9.0/Todo.Api.AssemblyInfo.cs",
      "public sealed class AssemblyInfo {}\n",
    );
    await writeFixture(
      root,
      "tests/Todo.Api.Tests/Todo.Api.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
    <ProjectReference Include="..\\..\\src\\Todo.Api\\Todo.Api.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "tests/Todo.Api.Tests/TodoControllerTests.cs",
      "public sealed class TodoControllerTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const health = result.features.find(
      (feature) => feature.title === "ASP.NET endpoint GET /health",
    );
    const controller = result.features.find(
      (feature) => feature.title === "ASP.NET controller TodoController",
    );
    const ownedFiles = new Set(
      result.features.flatMap((feature) => feature.ownedFiles.map((file) => file.path)),
    );

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.frameworks).toEqual(
      expect.arrayContaining(["aspnetcore", "dotnet-test"]),
    );
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build TodoApp.sln",
      test: "dotnet test TodoApp.sln",
    });
    expect(titles).toContain(".NET project Todo.Api");
    expect(titles).toContain(".NET project Todo.Api.Tests");
    expect(titles).toContain("C# test suite Todo.Api.Tests");
    expect(titles).toContain("ASP.NET endpoint GET /health");
    expect(titles).toContain("ASP.NET endpoint GET /todos");
    expect(titles).toContain("ASP.NET endpoint POST /todos");
    expect(titles).toContain("ASP.NET endpoint FALLBACKTOFILE /{*path:nonfile}");
    expect(titles).not.toContain("ASP.NET endpoint FALLBACKTOFILE /index.html");
    expect(titles).toContain("ASP.NET controller TodoController");
    expect(titles).toContain("C# source src/Todo.Api");
    expect(titles).toContain("Project config global.json");
    expect(health?.tests).toEqual([
      {
        path: "tests/Todo.Api.Tests/TodoControllerTests.cs",
        command: "dotnet test tests/Todo.Api.Tests/Todo.Api.Tests.csproj",
      },
    ]);
    expect(health?.contextFiles).toContainEqual({
      path: "tests/Todo.Api.Tests/TodoControllerTests.cs",
      reason: "associated test",
    });
    expect(controller?.summary).not.toContain("ListTodos");
    expect(ownedFiles).not.toContain("src/Todo.Api/Generated/TodoClient.g.cs");
    expect(ownedFiles).not.toContain("src/Todo.Api/obj/Debug/net9.0/Todo.Api.AssemblyInfo.cs");
  });

  it("does not map NuGet.config into review context", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-nuget-config-");
    await writeFixture(
      root,
      "NuGet.config",
      "<packageSourceCredentials>secret</packageSourceCredentials>\n",
    );
    await writeFixture(root, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "Program.cs", "public sealed class Program {}\n");

    const result = await mapFeatures(root, await detectProject(root), []);
    const referencedPaths = result.features.flatMap((feature) => [
      feature.entrypoints[0]?.path,
      ...feature.ownedFiles.map((file) => file.path),
      ...feature.contextFiles.map((file) => file.path),
      ...feature.tests.map((test) => test.path),
    ]);

    expect(result.features.map((feature) => feature.title)).not.toContain(
      "Project config NuGet.config",
    );
    expect(referencedPaths).not.toContain("NuGet.config");
  });

  it("preserves ASP.NET minimal API route group prefixes", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-map-group-");
    await writeFixture(
      root,
      "src/Grouped.Api/Grouped.Api.csproj",
      `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net9.0</TargetFramework>
  </PropertyGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/Grouped.Api/Program.cs",
      `var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();
app.MapGroup("/v1").MapGet("/users", () => Results.Ok());
app.MapGroup("/v2").MapGet("/users", () => Results.Ok());
var admin = app.MapGroup("/admin");
admin.MapGet("/users", () => Results.Ok());
var reports = admin.MapGroup("/reports");
reports.MapPost("/{id}", () => Results.Ok());
RouteGroupBuilder ApiGroup(WebApplication app) =>
    app.MapGroup("/api")
        .WithTags("api");
var helperGroup = ApiGroup(app);
helperGroup.MapDelete("/teams/{id}", () => Results.Ok());
app.Run();
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const endpointTitles = result.features
      .map((feature) => feature.title)
      .filter((title) => title.startsWith("ASP.NET endpoint "));

    expect(endpointTitles).toEqual(
      expect.arrayContaining([
        "ASP.NET endpoint GET /v1/users",
        "ASP.NET endpoint GET /v2/users",
        "ASP.NET endpoint GET /admin/users",
        "ASP.NET endpoint POST /admin/reports/{id}",
        "ASP.NET endpoint DELETE /api/teams/{id}",
      ]),
    );
    expect(endpointTitles).not.toContain("ASP.NET endpoint GET /users");
  });

  it("keeps .NET validation commands conservative for ambiguous workspaces", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-ambiguous-");
    await writeFixture(root, "First.sln", "");
    await writeFixture(root, "Second.sln", "");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.commands.typecheck).toBeNull();
    expect(project.detected.commands.test).toBe("dotnet test tests/App.Tests/App.Tests.csproj");
  });

  it("targets a lone .NET test project when the build solution omits it", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-missing-test-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe("dotnet build App.sln");
    expect(project.detected.commands.test).toBe("dotnet test tests/App.Tests/App.Tests.csproj");
  });

  it("does not build a root .NET solution that omits non-test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-missing-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("does not build a .NET solution with stale project entries", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-stale-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Lib", "src\\Lib\\Lib.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Missing", "src\\Missing\\Missing.csproj", "{33333333-3333-3333-3333-333333333333}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("does not build a .NET solution with out-of-root project entries", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-solution-outside-project-");
    await writeFixture(
      root,
      "App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "App", "src\\App\\App.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Lib", "src\\Lib\\Lib.csproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "Outside", "..\\Outside\\Outside.csproj", "{33333333-3333-3333-3333-333333333333}"
EndProject
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBeNull();
  });

  it("ignores commented .NET slnx project entries for validation targets", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-slnx-commented-project-");
    await writeFixture(
      root,
      "App.slnx",
      `<Solution>
  <Project Path="src/App/App.csproj" />
  <!-- <Project Path="src/Lib/Lib.csproj" /> -->
</Solution>
`,
    );
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/Lib/Lib.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const libProject = result.features.find((feature) => feature.title === ".NET project Lib");

    expect(project.detected.commands.typecheck).toBeNull();
    expect(libProject?.contextFiles).not.toContainEqual({
      path: "App.slnx",
      reason: "solution context",
    });
  });

  it("prefers a root .NET project over an unrelated nested solution", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-root-project-nested-solution-");
    await writeFixture(root, "App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tools/Tool.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "Tool", "Tool.csproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
`,
    );
    await writeFixture(root, "tools/Tool.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe("dotnet build App.csproj");
  });

  it("ignores .NET test metadata inside XML comments", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-commented-test-metadata-");
    await writeFixture(
      root,
      "src/App/App.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <!--
  <Project Sdk="Microsoft.NET.Sdk.Web">
  <PackageReference Include="Microsoft.Extensions.Hosting" Version="9.0.0" />
  <PackageReference Include="Microsoft.AspNetCore.OpenApi" Version="9.0.0" />
  <Using Include="BackgroundService" />
  <PropertyGroup>
    <IsTestProject>true</IsTestProject>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <PackageReference Include="xunit" Version="2.9.2" />
  </ItemGroup>
  -->
</Project>
`,
    );
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appProject = result.features.find((feature) => feature.title === ".NET project App");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.frameworks).not.toContain("dotnet-test");
    expect(project.detected.frameworks).not.toContain("aspnetcore");
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build src/App/App.csproj",
      test: null,
    });
    expect(titles).toContain(".NET project App");
    expect(titles).toContain("C# source src/App");
    expect(titles).not.toContain("C# test suite App");
    expect(appProject?.kind).toBe("library");
    expect(appProject?.tags).not.toContain("aspnetcore");
    expect(appProject?.tags).not.toContain("worker");
  });

  it("does not treat Program.cs as ASP.NET evidence for ordinary C# projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-console-program-controller-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", 'Console.WriteLine("hello");\n');
    await writeFixture(
      root,
      "src/App/Domain/MotorController.cs",
      "public sealed class MotorController {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.frameworks).not.toContain("aspnetcore");
    expect(titles).not.toContain("ASP.NET controller MotorController");
    expect(appSource?.ownedFiles).toEqual(
      expect.arrayContaining([
        { path: "src/App/Program.cs", reason: "C# source group src/App" },
        { path: "src/App/Domain/MotorController.cs", reason: "C# source group src/App" },
      ]),
    );
  });

  it("discovers first-party .NET projects under packages workspaces", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-packages-workspace-");
    await writeFixture(root, "packages/Foo/Foo.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "packages/Foo/Service.cs", "public sealed class Service {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).toContain("dotnet");
    expect(project.detected.commands).toMatchObject({
      typecheck: "dotnet build packages/Foo/Foo.csproj",
      test: null,
    });
    expect(titles).toContain(".NET project Foo");
    expect(titles).toContain("C# source packages/Foo");
  });

  it("targets the discovered .NET test project when the build target is an app project", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-root-app-nested-test-");
    await writeFixture(root, "My App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(
      root,
      "tests/My App.Tests/My App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);

    expect(project.detected.commands.typecheck).toBe('dotnet build "My App.csproj"');
    expect(project.detected.commands.test).toBe(
      'dotnet test "tests/My App.Tests/My App.Tests.csproj"',
    );
  });

  it("detects TUnit projects without Microsoft.NET.Test.Sdk as .NET test projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-tunit-test-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tests/App.TUnit/App.TUnit.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="TUnit" Version="1.13.11" />
    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "tests/App.TUnit/ProgramTests.cs",
      "public sealed class ProgramTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const testSuite = result.features.find(
      (feature) => feature.title === "C# test suite App.TUnit",
    );
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");

    expect(project.detected.frameworks).toContain("dotnet-test");
    expect(project.detected.commands.test).toBe("dotnet test tests/App.TUnit/App.TUnit.csproj");
    expect(testSuite?.tests).toEqual([
      {
        path: "tests/App.TUnit/ProgramTests.cs",
        command: "dotnet test tests/App.TUnit/App.TUnit.csproj",
      },
    ]);
    expect(appSource?.tests).toEqual([
      {
        path: "tests/App.TUnit/ProgramTests.cs",
        command: "dotnet test tests/App.TUnit/App.TUnit.csproj",
      },
    ]);
  });

  it("keeps dotnet test commands for test projects without C# source files", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-empty-test-group-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "tests/App.Tests/App.Tests.fsproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\src\\App\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const testSuite = result.features.find(
      (feature) => feature.title === "F# test suite App.Tests",
    );
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");

    expect(testSuite?.tests).toEqual([
      {
        path: "tests/App.Tests/App.Tests.fsproj",
        command: "dotnet test tests/App.Tests/App.Tests.fsproj",
      },
    ]);
    expect(appSource?.tests).toEqual([
      {
        path: "tests/App.Tests/App.Tests.fsproj",
        command: "dotnet test tests/App.Tests/App.Tests.fsproj",
      },
    ]);
  });

  it("maps F# and Visual Basic source groups with solution context", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-fsharp-vb-source-");
    await writeFixture(
      root,
      "solutions/App.sln",
      `Microsoft Visual Studio Solution File, Format Version 12.00
Project("{00000000-0000-0000-0000-000000000000}") = "FsLib", "..\\src\\FsLib\\FsLib.fsproj", "{11111111-1111-1111-1111-111111111111}"
EndProject
Project("{00000000-0000-0000-0000-000000000000}") = "FsLib.Tests", "..\\tests\\FsLib.Tests\\FsLib.Tests.fsproj", "{22222222-2222-2222-2222-222222222222}"
EndProject
`,
    );
    await writeFixture(
      root,
      "solutions/App.slnx",
      '<Solution><Project Path="../src/VbApp/VbApp.vbproj" /></Solution>\n',
    );
    await writeFixture(root, "src/FsLib/FsLib.fsproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/FsLib/Library.fs", 'module Library\nlet hello = "world"\n');
    await writeFixture(
      root,
      "tests/FsLib.Tests/FsLib.Tests.fsproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\src\\FsLib\\FsLib.fsproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(root, "tests/FsLib.Tests/Tests.fs", "module Tests\n");
    await writeFixture(root, "src/VbApp/VbApp.vbproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/VbApp/Program.vb", "Module Program\nEnd Module\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const fsProject = result.features.find((feature) => feature.title === ".NET project FsLib");
    const fsSource = result.features.find((feature) => feature.title === "F# source src/FsLib");
    const vbProject = result.features.find((feature) => feature.title === ".NET project VbApp");
    const vbSource = result.features.find(
      (feature) => feature.title === "Visual Basic source src/VbApp",
    );

    expect(project.detected.languages).toEqual(expect.arrayContaining(["fsharp", "visual-basic"]));
    expect(fsProject?.contextFiles).toContainEqual({
      path: "solutions/App.sln",
      reason: "solution context",
    });
    expect(vbProject?.contextFiles).toContainEqual({
      path: "solutions/App.slnx",
      reason: "solution context",
    });
    expect(fsSource?.ownedFiles).toEqual([
      { path: "src/FsLib/Library.fs", reason: "F# source group src/FsLib" },
    ]);
    expect(fsSource?.tests).toEqual([
      {
        path: "tests/FsLib.Tests/Tests.fs",
        command: "dotnet test tests/FsLib.Tests/FsLib.Tests.fsproj",
      },
    ]);
    expect(vbSource?.ownedFiles).toEqual([
      { path: "src/VbApp/Program.vb", reason: "Visual Basic source group src/VbApp" },
    ]);
  });

  it("excludes nested .NET project roots from parent C# source groups", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-nested-project-root-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Program.cs", "public sealed class Program {}\n");
    await writeFixture(
      root,
      "src/App/tests/App.Tests/App.Tests.csproj",
      `<Project Sdk="Microsoft.NET.Sdk">
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.12.0" />
    <ProjectReference Include="..\\..\\App.csproj" />
  </ItemGroup>
</Project>
`,
    );
    await writeFixture(
      root,
      "src/App/tests/App.Tests/ProgramTests.cs",
      "public sealed class ProgramTests {}\n",
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const appSource = result.features.find((feature) => feature.title === "C# source src/App");
    const testSuite = result.features.find(
      (feature) => feature.title === "C# test suite App.Tests",
    );

    expect(appSource?.ownedFiles).toEqual([
      { path: "src/App/Program.cs", reason: "C# source group src/App" },
    ]);
    expect(testSuite?.ownedFiles).toEqual([
      {
        path: "src/App/tests/App.Tests/ProgramTests.cs",
        reason: "C# test group src/App/tests/App.Tests",
      },
    ]);
  });

  it("does not report dotnet as a package manager for manifestless C# source", async () => {
    const root = await fixtureRoot("clawpatch-csharp-source-only-");
    await writeFixture(root, "src/Helpers/Thing.cs", "public sealed class Thing {}\n");
    await writeFixture(root, "src/Helpers/Thing.g.cs", "public sealed class GeneratedThing {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const source = result.features.find((feature) => feature.title === "C# source src");
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("csharp");
    expect(project.detected.packageManagers).not.toContain("dotnet");
    expect(project.detected.commands).toEqual({
      typecheck: null,
      lint: null,
      format: null,
      test: null,
    });
    expect(titles).not.toContain(".NET project Thing");
    expect(source?.ownedFiles).toEqual([
      { path: "src/Helpers/Thing.cs", reason: "C# source group src" },
    ]);
  });

  it("keeps Ruby validation defaults when a Ruby project has source-only C#", async () => {
    const root = await fixtureRoot("clawpatch-ruby-csharp-source-only-");
    await writeFixture(
      root,
      "Gemfile",
      "source 'https://rubygems.org'\ngem 'rspec'\ngem 'rubocop'\n",
    );
    await writeFixture(root, "lib/fixture.rb", "module Fixture\nend\n");
    await writeFixture(root, "src/Helpers/Thing.cs", "public sealed class Thing {}\n");

    const project = await detectProject(root);

    expect(project.detected.languages).toEqual(expect.arrayContaining(["ruby", "csharp"]));
    expect(project.detected.packageManagers).toContain("bundler");
    expect(project.detected.packageManagers).not.toContain("dotnet");
    expect(project.detected.commands).toMatchObject({
      lint: "bundle exec rubocop",
      test: "bundle exec rspec",
    });
  });

  it("skips fixture and testdata .NET projects", async () => {
    const root = await fixtureRoot("clawpatch-dotnet-samples-");
    await writeFixture(root, "src/App/App.csproj", '<Project Sdk="Microsoft.NET.Sdk" />\n');
    await writeFixture(root, "src/App/Service.cs", "public sealed class Service {}\n");
    await writeFixture(
      root,
      "fixtures/Sample/Sample.csproj",
      '<Project Sdk="Microsoft.NET.Sdk" />\n',
    );
    await writeFixture(root, "fixtures/Sample/Sample.cs", "public sealed class Sample {}\n");
    await writeFixture(
      root,
      "testdata/Example/Example.csproj",
      '<Project Sdk="Microsoft.NET.Sdk" />\n',
    );
    await writeFixture(root, "testdata/Example/Example.cs", "public sealed class Example {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const ownedFiles = result.features.flatMap((feature) =>
      feature.ownedFiles.map((file) => file.path),
    );

    expect(titles).toContain(".NET project App");
    expect(titles).not.toContain(".NET project Sample");
    expect(titles).not.toContain(".NET project Example");
    expect(ownedFiles).not.toContain("fixtures/Sample/Sample.cs");
    expect(ownedFiles).not.toContain("testdata/Example/Example.cs");
  });
});
