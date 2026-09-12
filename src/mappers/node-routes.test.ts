import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

describe("mapFeatures", () => {
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

  it("preserves literal Express and Hono mount prefixes for child routes", async () => {
    const root = await fixtureRoot("clawpatch-node-mounted-route-prefixes-");
    await writeFixture(
      root,
      "package.json",
      JSON.stringify(
        {
          name: "mounted-route-server",
          dependencies: { express: "1.0.0", hono: "1.0.0" },
        },
        null,
        2,
      ),
    );
    await writeFixture(
      root,
      "src/express-mounted.ts",
      [
        "import express, { Router } from 'express';",
        "import ensureLoggedIn from './auth';",
        "",
        "const app = express();",
        "const apiApp = express();",
        "const router = Router();",
        "const nestedRouter = Router();",
        "const middlewareRouter = Router();",
        "const genericMiddlewareRouter = Router();",
        "const asyncMiddlewareRouter = Router();",
        "const expressionMiddlewareRouter = Router();",
        "const importedMiddlewareRouter = Router();",
        "const pathlessRouter = Router();",
        "const directPathlessRouter = Router();",
        "const firstPathlessRouter = Router();",
        "const secondPathlessRouter = Router();",
        "const arrayRouter = Router();",
        "const wildcardRouter = Router();",
        "const dynamicRouter = Router();",
        "const dynamicParent = Router();",
        "const dynamicChild = Router();",
        "const authPathRouter = Router();",
        "const tenantRouter = Router();",
        "const memberRouter = Router();",
        "const falseRouter = Router();",
        "const notApp = createClient();",
        "app.use('/api', router);",
        "app.use(dynamicTenant, router);",
        "app.use('/service', apiApp);",
        "router.use('/v1', nestedRouter);",
        "app.use('/middleware', requireAuth, middlewareRouter);",
        "apiApp.use(mw, genericMiddlewareRouter);",
        "apiApp.use(amw, asyncMiddlewareRouter);",
        "apiApp.use(express.json(), expressionMiddlewareRouter);",
        "apiApp.use(ensureLoggedIn, importedMiddlewareRouter);",
        "apiApp.use(requireAuth, pathlessRouter);",
        "apiApp.use(directPathlessRouter);",
        "apiApp.use(firstPathlessRouter, secondPathlessRouter);",
        "app.use(['/array', '/alt-array'], arrayRouter);",
        "app.use('*', wildcardRouter);",
        "app.use(dynamicPrefix, dynamicRouter);",
        "app.use(dynamicBase, dynamicParent);",
        "dynamicParent.use('/v1', dynamicChild);",
        "app.use(authPath, authPathRouter);",
        "app.use(tenant, tenantRouter);",
        "server.app.use('/member', memberRouter);",
        "notApp.use('/false', falseRouter);",
        "router.get('/users', listUsers);",
        "router.route('/reports').get(listReports);",
        "nestedRouter.post('/teams', createTeam);",
        "apiApp.delete('/sessions/:id', deleteSession);",
        "middlewareRouter.get('/users', listMiddlewareUsers);",
        "genericMiddlewareRouter.get('/generic-middleware-users', listGenericMiddlewareUsers);",
        "asyncMiddlewareRouter.get('/async-middleware-users', listAsyncMiddlewareUsers);",
        "expressionMiddlewareRouter.get('/json-users', listJsonUsers);",
        "importedMiddlewareRouter.get('/imported-users', listImportedUsers);",
        "pathlessRouter.get('/pathless-users', listPathlessUsers);",
        "directPathlessRouter.get('/direct-pathless-users', listDirectPathlessUsers);",
        "firstPathlessRouter.get('/first-pathless-users', listFirstPathlessUsers);",
        "secondPathlessRouter.get('/second-pathless-users', listSecondPathlessUsers);",
        "arrayRouter.get('/array-users', listArrayUsers);",
        "wildcardRouter.get('/wildcard-users', listWildcardUsers);",
        "dynamicRouter.get('/dynamic-users', dynamicUsers);",
        'dynamicChild.get("/dynamic-child-users", dynamicChildUsers);',
        'authPathRouter.get("/auth-path-users", authPathUsers);',
        'tenantRouter.get("/tenant-users", tenantUsers);',
        'memberRouter.get("/member-users", memberUsers);',
        "falseRouter.get('/false-users', falseUsers);",
        "function createClient() { return { use() {} }; }",
        "function listUsers() {}",
        "function listReports() {}",
        "function createTeam() {}",
        "function deleteSession() {}",
        "function requireAuth() {}",
        "function mw() {}",
        "async function amw() {}",
        "function listMiddlewareUsers() {}",
        "function listGenericMiddlewareUsers() {}",
        "function listAsyncMiddlewareUsers() {}",
        "function listJsonUsers() {}",
        "function listImportedUsers() {}",
        "function listPathlessUsers() {}",
        "function listDirectPathlessUsers() {}",
        "function listFirstPathlessUsers() {}",
        "function listSecondPathlessUsers() {}",
        "function listArrayUsers() {}",
        "function listWildcardUsers() {}",
        "function dynamicUsers() {}",
        "function dynamicChildUsers() {}",
        "function authPathUsers() {}",
        "function tenantUsers() {}",
        "function memberUsers() {}",
        "function falseUsers() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/hono-mounted.ts",
      [
        "import { Hono } from 'hono';",
        "",
        "const app = new Hono();",
        "const subApp = new Hono();",
        "const nestedSubApp = new Hono();",
        "const dynamicSubApp = new Hono();",
        "const falseSubApp = new Hono();",
        "const client = createClient();",
        "app.route('/api', subApp);",
        "subApp.route('/v1', nestedSubApp);",
        "app.route(dynamicPrefix, dynamicSubApp);",
        "client.route('/false', falseSubApp);",
        "subApp.get('/users', listUsers);",
        "nestedSubApp.delete('/sessions/:id', deleteSession);",
        "dynamicSubApp.get('/dynamic-users', dynamicUsers);",
        "falseSubApp.get('/false-users', falseUsers);",
        "function createClient() { return { route() {} }; }",
        "function listUsers() {}",
        "function deleteSession() {}",
        "function dynamicUsers() {}",
        "function falseUsers() {}",
        "",
      ].join("\n"),
    );
    await writeFixture(
      root,
      "src/express-dynamic-mw.ts",
      [
        "import express, { Router } from 'express';",
        "",
        "const app = express();",
        "const router = Router();",
        "const mw = dynamicPrefix;",
        "app.use(mw, router);",
        "router.get('/dynamic-mw-users', listDynamicMwUsers);",
        "function listDynamicMwUsers() {}",
        "",
      ].join("\n"),
    );

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toEqual(
      expect.arrayContaining([
        "Express route GET /api/users",
        "Express route GET /api/reports",
        "Express route POST /api/v1/teams",
        "Express route DELETE /service/sessions/:id",
        "Express route GET /middleware/users",
        "Express route GET /service/generic-middleware-users",
        "Express route GET /service/async-middleware-users",
        "Express route GET /service/json-users",
        "Express route GET /service/imported-users",
        "Express route GET /service/pathless-users",
        "Express route GET /service/direct-pathless-users",
        "Express route GET /service/first-pathless-users",
        "Express route GET /service/second-pathless-users",
        "Express route GET /array/array-users",
        "Express route GET /alt-array/array-users",
        "Express route GET /*/wildcard-users",
        "Express route GET /member-users",
        "Hono route GET /api/users",
        "Hono route DELETE /api/v1/sessions/:id",
      ]),
    );
    expect(titles).not.toContain("Express route GET /users");
    expect(titles).not.toContain("Express route GET /reports");
    expect(titles).not.toContain("Express route POST /v1/teams");
    expect(titles).not.toContain("Express route DELETE /sessions/:id");
    expect(titles).not.toContain("Express route GET /false/false-users");
    expect(titles).not.toContain("Express route GET /generic-middleware-users");
    expect(titles).not.toContain("Express route GET /async-middleware-users");
    expect(titles).not.toContain("Express route GET /json-users");
    expect(titles).not.toContain("Express route GET /imported-users");
    expect(titles).not.toContain("Express route GET /pathless-users");
    expect(titles).not.toContain("Express route GET /direct-pathless-users");
    expect(titles).not.toContain("Express route GET /first-pathless-users");
    expect(titles).not.toContain("Express route GET /second-pathless-users");
    expect(titles).not.toContain("Express route GET /array-users");
    expect(titles).not.toContain("Express route GET /wildcard-users");
    expect(titles).not.toContain("Express route GET /dynamic-users");
    expect(titles).not.toContain("Express route GET /dynamic-child-users");
    expect(titles).not.toContain("Express route GET /auth-path-users");
    expect(titles).not.toContain("Express route GET /dynamic-mw-users");
    expect(titles).not.toContain("Express route GET /tenant-users");
    expect(titles).not.toContain("Express route GET /member/member-users");
    expect(titles).not.toContain("Express route GET /v1/dynamic-child-users");
    expect(titles).not.toContain("Hono route GET /users");
    expect(titles).not.toContain("Hono route GET /dynamic-users");
    expect(titles).not.toContain("Hono route DELETE /v1/sessions/:id");
    expect(titles).not.toContain("Hono route GET /false/false-users");
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
});
