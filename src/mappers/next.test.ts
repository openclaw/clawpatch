import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
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
});
