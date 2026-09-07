import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initCommand, makeContext, mapCommand, reviewCommand } from "./app.js";
import { parseArgs } from "./cli.js";
import { defaultConfig } from "./config.js";
import { findHttpRelations, httpEndpoints, httpRoots, withHttpContext } from "./http-relations.js";
import { buildReviewPromptBundle } from "./prompt.js";
import { readFeatures, readProject, statePaths } from "./state.js";
import { testOptions, writeFixture } from "./test-helpers.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "clawpatch-http-"));
  roots.push(root);
  await writeFixture(
    root,
    "package.json",
    JSON.stringify({ name: "http-test", workspaces: ["frontend"] }),
  );
  await writeFixture(
    root,
    "frontend/package.json",
    JSON.stringify({ name: "frontend", type: "module" }),
  );
  await writeFixture(root, "frontend/src/app.ts", 'await fetch("/api/login");\n');
  await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["backend"]\nresolver = "2"\n');
  await writeFixture(
    root,
    "backend/Cargo.toml",
    '[package]\nname = "backend"\nversion = "0.1.0"\nedition = "2021"\n',
  );
  await writeFixture(
    root,
    "backend/src/main.rs",
    '#[get("/api/login")]\nasync fn login() {}\nfn main() {}\n',
  );
  const context = await makeContext({ ...testOptions(root), quiet: true });
  await initCommand(context, {});
  const baseline = await mapCommand(context, {});
  const paths = statePaths(join(root, ".clawpatch"));
  const features = await readFeatures(paths);
  const scan = () =>
    findHttpRelations(root, features, "frontend:backend", { include: ["**"], exclude: [] });
  return { root, context, baseline, paths, features, scan };
}

describe("HTTP candidate context", () => {
  it("preserves mapping records and adds current counterpart files only to a bounded prompt copy", async () => {
    const setup = await fixture();
    expect(setup.baseline).not.toHaveProperty("http");
    const before = await readFeatures(setup.paths);
    const mapped = (await mapCommand(setup.context, {
      linkHttp: "frontend:backend",
      dryRun: true,
    })) as { http: Awaited<ReturnType<typeof setup.scan>> };
    expect(mapped.http.relations).toHaveLength(1);
    expect(mapped.http.relations[0]).toMatchObject({
      method: "GET",
      path: "/api/login",
      caller: { file: "frontend/src/app.ts", line: 1 },
      handler: { file: "backend/src/main.rs", line: 1 },
    });
    expect(await readFeatures(setup.paths)).toEqual(before);
    const relation = mapped.http.relations[0]!;
    const backend = setup.features.find((f) => f.featureId === relation.handler.featureIds[0])!;
    const enriched = withHttpContext(backend, mapped.http.relations);
    expect(enriched.contextFiles).toContainEqual({
      path: "frontend/src/app.ts",
      reason: "candidate HTTP GET /api/login; verify runtime routing",
    });
    expect(backend.contextFiles).not.toContainEqual(
      expect.objectContaining({ path: "frontend/src/app.ts" }),
    );
    const project = (await readProject(setup.paths))!;
    const prompt = await buildReviewPromptBundle(setup.root, project, enriched, defaultConfig());
    expect(prompt.manifest.includedFiles).toContainEqual(
      expect.objectContaining({ path: "frontend/src/app.ts", readable: true, role: "context" }),
    );
    expect(prompt.prompt).toContain('await fetch("/api/login")');
    const config = defaultConfig();
    config.review.maxContextFiles = 1;
    const limited = await buildReviewPromptBundle(setup.root, project, enriched, config);
    expect(limited.manifest.omittedFiles).toContainEqual({
      path: "frontend/src/app.ts",
      role: "context",
      reason: "maxContextFiles",
    });
    await writeFixture(
      setup.root,
      "backend/src/main.rs",
      '#[post("/api/login")]\nasync fn login() {}\nfn main() {}\n',
    );
    expect((await setup.scan()).relations).toEqual([]);
  });

  it("uses HTTP context during review without storing it or enabling later reviews", async () => {
    const setup = await fixture();
    await writeFixture(setup.root, "frontend/src/app.ts", 'fetch("/api/login"); // TODO_BUG\n');
    const backend = setup.features.find((f) => f.source === "rust-command")!;
    const flags = { feature: backend.featureId, provider: "mock" };
    expect(await reviewCommand(setup.context, flags)).toMatchObject({ findings: 0 });
    expect(
      await reviewCommand(setup.context, { ...flags, linkHttp: "frontend:backend" }),
    ).toMatchObject({ findings: 1 });
    const saved = (await readFeatures(setup.paths)).find((f) => f.featureId === backend.featureId)!;
    expect(saved.contextFiles).toEqual(backend.contextFiles);
    expect(await reviewCommand(setup.context, flags)).toMatchObject({ findings: 0 });
  });

  it("rejects ambiguity in one file and unresolved mount prefixes", async () => {
    const setup = await fixture();
    await writeFixture(
      setup.root,
      "backend/src/main.rs",
      '#[get("/api/login")]\nfn a() {}\n#[get("/api/login")]\nfn b() {}\n',
    );
    expect((await setup.scan()).relations).toEqual([]);
    await writeFixture(
      setup.root,
      "backend/src/main.rs",
      '#[get("/api/login")]\nfn a() {}\nweb::scope("/v2");\n',
    );
    expect((await setup.scan()).skippedReason).toContain("prefixes");
    await writeFixture(
      setup.root,
      "backend/src/main.rs",
      '#[get("/api/login")]\nfn login() {}\nfn main() {}\n',
    );
    await writeFixture(
      setup.root,
      "backend/src/config.rs",
      'fn configure(server: Rocket<Build>) -> Rocket<Build> { server.mount("/v2", routes![login]) }\n',
    );
    expect((await setup.scan()).skippedReason).toContain("prefixes");
    await writeFixture(
      setup.root,
      "backend/src/config.rs",
      'fn configure(server: Rocket<Build>) { server./* prefix */mount("/v2", routes![login]); }\n',
    );
    expect((await setup.scan()).skippedReason).toContain("prefixes");
    await writeFixture(
      setup.root,
      "backend/src/config.rs",
      'fn configure() { web/* prefix */::scope("/v2"); }\n',
    );
    expect((await setup.scan()).skippedReason).toContain("prefixes");
    await writeFixture(
      setup.root,
      "backend/src/config.rs",
      'fn configure(server: Rocket<Build>) { server.mount::<_, _>("/v2", routes![login]); }\n',
    );
    expect((await setup.scan()).skippedReason).toContain("prefixes");
  });

  it("honors filters and refuses partial scans, missing sources, and symlinked roots", async () => {
    const setup = await fixture();
    expect(
      (
        await findHttpRelations(setup.root, setup.features, "frontend:backend", {
          include: ["**"],
          exclude: ["backend/**"],
        })
      ).relations,
    ).toEqual([]);
    await writeFixture(setup.root, "backend/src/oversized.rs", " ".repeat(256_001));
    expect(await setup.scan()).toMatchObject({
      relations: [],
      skippedReason: expect.stringContaining("byte budget"),
    });
    await symlink(join(setup.root, "frontend"), join(setup.root, "alias"), "dir");
    await expect(
      findHttpRelations(setup.root, setup.features, "frontend:alias", {
        include: ["**"],
        exclude: [],
      }),
    ).rejects.toThrow("must not overlap");
    const outside = await mkdtemp(join(tmpdir(), "clawpatch-http-outside-"));
    roots.push(outside);
    await symlink(outside, join(setup.root, "external"), "dir");
    await expect(
      findHttpRelations(setup.root, setup.features, "frontend:external", {
        include: ["**"],
        exclude: [],
      }),
    ).rejects.toThrow("invalid HTTP relation root");
    await expect(
      findHttpRelations(setup.root, setup.features, "frontend:missing", {
        include: ["**"],
        exclude: [],
      }),
    ).rejects.toThrow("invalid HTTP relation root");
  });

  it("ignores unsupported files before budgeting and unrelated scope text", async () => {
    const setup = await fixture();
    await Promise.all(
      Array.from({ length: 501 }, (_, i) =>
        writeFixture(setup.root, `frontend/ui/part${i}.tsx`, ""),
      ),
    );
    await writeFixture(setup.root, "frontend/ui/large.tsx", " ".repeat(256_001));
    await writeFixture(
      setup.root,
      "backend/src/main.rs",
      '#[get("/api/login")]\nfn login() {}\n// web::scope("/ignored")\nlet example = "web::scope(";\nstd::thread::scope(|s| {});\n',
    );
    expect((await setup.scan()).relations).toHaveLength(1);
  });

  it("caps review context independently from the mapped relations", async () => {
    const setup = await fixture();
    for (let i = 0; i < 5; i++)
      await writeFixture(setup.root, `frontend/src/client${i}.ts`, 'fetch("/api/login");\n');
    await mapCommand(setup.context, {});
    const features = await readFeatures(setup.paths);
    const result = await findHttpRelations(setup.root, features, "frontend:backend", {
      include: ["**"],
      exclude: [],
    });
    expect(result.relations).toHaveLength(6);
    expect(result.omitted).toBe(0);
    const backend = features.find((f) => f.source === "rust-command")!;
    const context = withHttpContext(backend, result.relations).contextFiles.filter((ref) =>
      ref.reason.startsWith("candidate HTTP"),
    );
    expect(context.map((ref) => ref.path)).toEqual([
      "frontend/src/app.ts",
      "frontend/src/client0.ts",
      "frontend/src/client1.ts",
    ]);
  });
});

describe("literal HTTP syntax", () => {
  it("matches methods exactly and rejects options, members, templates, absolute/dynamic paths", () => {
    const source = `fetch("/get"); fetch('/post', { method: "POST" }); fetch("/no", options); fetch("/no", { ...options }); obj.fetch("/no"); fetch(\`/no\`); fetch("https://host/no"); fetch("//host/no"); fetch("/no?q=x"); fetch("/users/:id"); fetch("/get", { method: verb });`;
    expect(
      httpEndpoints(source, "client.ts", "caller").map(({ method, path }) => [method, path]),
    ).toEqual([
      ["GET", "/get"],
      ["POST", "/post"],
    ]);
  });

  it("ignores comments, regexes, templates, strings, Rust raw strings and nested comments", () => {
    expect(
      httpEndpoints(
        '// fetch("/no")\n/* fetch("/no") */\nconst x = \'fetch("/no")\';\nconst t = `fetch("/no")`;\nconst regex = /fetch(.+)/;\nfetch("/yes")',
        "client.ts",
        "caller",
      ).map((r) => r.path),
    ).toEqual(["/yes"]);
    const source =
      '// #[get("/no")]\n/* /* nested */ #[get("/no")] */\nlet s = r###" #[get("/no")] "###;\n#[post("/yes")]\nfn yes() {}';
    expect(
      httpEndpoints(source, "main.rs", "handler").map(({ method, path }) => [method, path]),
    ).toEqual([["POST", "/yes"]]);
  });

  it("does not confuse nested templates, JSX text, or spaced members with fetch calls", () => {
    const nested = 'const x = `outer ${`fetch("/fake")`} end`; fetch("/real");';
    expect(httpEndpoints(nested, "client.ts", "caller").map((r) => r.path)).toEqual(["/real"]);
    expect(
      httpEndpoints('object. fetch("/fake"); fetch("/real");', "client.ts", "caller").map(
        (r) => r.path,
      ),
    ).toEqual(["/real"]);
    expect(
      httpEndpoints(
        'client. /* wrapper */ fetch("/fake"); fetch("/real");',
        "client.ts",
        "caller",
      ).map((r) => r.path),
    ).toEqual(["/real"]);
    expect(httpEndpoints('<div>fetch("/fake")</div>', "client.tsx", "caller")).toEqual([]);
  });

  it("matches unescaped static path punctuation and Unicode", () => {
    for (const path of [
      "/users/@me",
      "/search/a+b",
      "/encoded/%2F",
      "/Über",
      "/authors/O'Reilly",
      "/time/12:00",
    ]) {
      const literal = JSON.stringify(path);
      expect(httpEndpoints(`fetch(${literal})`, "client.ts", "caller")[0]?.path).toBe(path);
      expect(httpEndpoints(`#[get(${literal})]`, "main.rs", "handler")[0]?.path).toBe(path);
    }
  });

  it("tracks line numbers across a dense supported source file", () => {
    const endpoints = httpEndpoints('fetch("/");\n'.repeat(20_000), "client.ts", "caller");
    expect(endpoints).toHaveLength(20_000);
    expect(endpoints[0]?.line).toBe(1);
    expect(endpoints.at(-1)?.line).toBe(20_000);
  });

  it("validates the explicit service pair and exposes it only on map/review", () => {
    for (const value of [
      "",
      "frontend",
      ".:backend",
      "../frontend:backend",
      "/frontend:backend",
      "front:front/back",
      "front:front",
      "front:back:third",
    ])
      expect(() => httpRoots(value)).toThrow();
    expect(httpRoots("apps/web:services/api")).toEqual(["apps/web", "services/api"]);
    for (const command of ["map", "review"])
      expect(parseArgs([command, "--link-http", "frontend:backend"]).flags["linkHttp"]).toBe(
        "frontend:backend",
      );
    expect(() => parseArgs(["ci", "--link-http", "frontend:backend"])).toThrow();
  });
});
