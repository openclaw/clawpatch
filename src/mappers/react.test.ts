import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;

describe("mapFeatures", () => {
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
    if (process.platform !== "win32") {
      await symlink(
        join(root, "../outside-linked.tsx"),
        join(root, "frontend/src/pages/LinkedPage.tsx"),
      );
    }
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

  symlinkIt("does not discover React packages through symlinked package roots", async () => {
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
});
