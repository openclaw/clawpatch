import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathExists } from "../fs.js";
import { shellQuotePath } from "../shell.js";
import { packageKind, pathMatchesPrefix, shouldSkip, stripLineComments, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

const elixirSourceGroupMaxOwnedFiles = 24;
const elixirTestGroupMaxFiles = 12;

type MixProjectMetadata = {
  appName: string | null;
  dependencies: Set<string>;
};

type ElixirSourceGroup = {
  label: string;
  files: string[];
};

export async function elixirSeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await isElixirProject(root))) {
    return [];
  }

  const metadata = await mixProjectMetadata(root);
  const testFiles = await elixirTestFiles(root);
  const seeds: FeatureSeed[] = [];
  const projectFiles = await existingFiles(root, ["mix.exs", "mix.lock", ".formatter.exs"]);

  if (projectFiles.length > 0) {
    seeds.push({
      title: `Mix project ${metadata.appName ?? basename(root)}`,
      summary: `Mix project metadata in ${projectFiles.join(", ")}.`,
      kind: packageKind(metadata.appName ?? basename(root)),
      source: "mix-project",
      confidence: "medium",
      entryPath: projectFiles[0] ?? "mix.exs",
      symbol: metadata.appName,
      route: null,
      command: null,
      ownedFiles: projectFiles.map((path) => ({ path, reason: "mix project metadata" })),
      contextFiles: [],
      tags: ["elixir", "mix"],
      trustBoundaries: mixTrustBoundaries(metadata),
      skipNearbyTests: true,
    });
  }

  for (const group of await elixirContextGroups(root, metadata.appName)) {
    const tests = associatedTests(group.files, testFiles);
    seeds.push({
      title: `Elixir context ${group.label}`,
      summary: `Elixir context ${group.label} with ${group.files.length} source files.`,
      kind: packageKind(group.label),
      source: "elixir-context",
      confidence: "high",
      entryPath: group.files[0] ?? group.label,
      identityKey: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `Elixir context ${group.label}` })),
      contextFiles: projectFiles.map((path) => ({ path, reason: "mix project metadata" })),
      tests,
      tags: ["elixir", "context", group.label],
      trustBoundaries: contextTrustBoundaries(group.label),
      skipNearbyTests: true,
    });
  }

  for (const group of await phoenixWebGroups(root, metadata.appName)) {
    const tests = associatedTests(group.files, testFiles);
    seeds.push({
      title: `Phoenix web ${group.label}`,
      summary: `Phoenix web ${group.label} slice with ${group.files.length} source files.`,
      kind: group.label === "live" || group.label === "components" ? "ui-flow" : "route",
      source: "phoenix-web",
      confidence: "high",
      entryPath: group.files[0] ?? group.label,
      identityKey: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `Phoenix web ${group.label}` })),
      contextFiles: await phoenixWebContextFiles(root, group.files),
      tests,
      tags: ["elixir", "phoenix", "web", group.label],
      trustBoundaries: webTrustBoundaries(group.label),
      skipNearbyTests: true,
    });
  }

  const configFiles = await walk(root, ["config"], shouldSkipMixPath).then((files) =>
    files.filter((path) => path.endsWith(".exs")),
  );
  if (configFiles.length > 0) {
    seeds.push({
      title: "Elixir runtime configuration",
      summary: "Elixir and Phoenix runtime configuration files.",
      kind: "config",
      source: "elixir-config",
      confidence: "high",
      entryPath: configFiles[0] ?? "config/config.exs",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: configFiles.map((path) => ({ path, reason: "Elixir runtime configuration" })),
      contextFiles: projectFiles.map((path) => ({ path, reason: "mix project metadata" })),
      tags: ["elixir", "config"],
      trustBoundaries: ["secrets", "network", "database"],
      skipNearbyTests: true,
    });
  }

  const migrationFiles = await walk(root, ["priv/repo/migrations"], shouldSkipMixPath).then(
    (files) => files.filter((path) => path.endsWith(".exs")),
  );
  if (migrationFiles.length > 0) {
    seeds.push({
      title: "Ecto migrations",
      summary: "Ecto migration files for database shape and constraint changes.",
      kind: "config",
      source: "ecto-migrations",
      confidence: "high",
      entryPath: migrationFiles[0] ?? "priv/repo/migrations",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: migrationFiles.map((path) => ({ path, reason: "Ecto migration" })),
      contextFiles: (await migrationContextFiles(root, metadata.appName)).map((path) => ({
        path,
        reason: "migration context",
      })),
      tags: ["elixir", "ecto", "database"],
      trustBoundaries: ["database", "permissions"],
      skipNearbyTests: true,
    });
  }

  const scriptFiles = await walk(root, ["scripts"], shouldSkipMixPath).then((files) =>
    files.filter((path) => path.endsWith(".exs") || path.endsWith(".sh")),
  );
  if (scriptFiles.length > 0) {
    seeds.push({
      title: "Project scripts",
      summary: "Project-local Elixir and shell scripts.",
      kind: "cli-command",
      source: "project-scripts",
      confidence: "medium",
      entryPath: scriptFiles[0] ?? "scripts",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: scriptFiles.map((path) => ({ path, reason: "project-local script" })),
      contextFiles: (await existingFiles(root, ["scripts/README.md", "mix.exs"])).map((path) => ({
        path,
        reason: "script context",
      })),
      tags: ["elixir", "scripts"],
      trustBoundaries: ["filesystem", "process-exec", "secrets", "network"],
      skipNearbyTests: true,
    });
  }

  return seeds;
}

async function isElixirProject(root: string): Promise<boolean> {
  return await pathExists(join(root, "mix.exs"));
}

async function mixProjectMetadata(root: string): Promise<MixProjectMetadata> {
  if (!(await pathExists(join(root, "mix.exs")))) {
    return { appName: null, dependencies: new Set() };
  }
  const source = stripLineComments(await readFile(join(root, "mix.exs"), "utf8"), "#");
  return {
    appName: extractAppName(source),
    dependencies: dependencyNames(source),
  };
}

function extractAppName(source: string): string | null {
  return /app:\s*:([a-zA-Z][a-zA-Z0-9_]*)/u.exec(source)?.[1] ?? null;
}

function dependencyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\{:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*,/gu)) {
    if (match[1] !== undefined) {
      names.add(match[1]);
    }
  }
  return names;
}

async function existingFiles(root: string, paths: string[]): Promise<string[]> {
  const output: string[] = [];
  for (const path of paths) {
    if (await pathExists(join(root, path))) {
      output.push(path);
    }
  }
  return output;
}

async function elixirContextGroups(
  root: string,
  appName: string | null,
): Promise<ElixirSourceGroup[]> {
  const appRoot = appName === null ? null : `lib/${appName}`;
  const roots = appRoot !== null && (await pathExists(join(root, appRoot))) ? [appRoot] : ["lib"];
  const groups = new Map<string, Set<string>>();

  for (const sourceRoot of roots) {
    for (const entry of await safeReadDir(join(root, sourceRoot))) {
      if (entry.isDirectory() && entry.name.endsWith("_web")) {
        continue;
      }

      const label = entry.isFile() ? entry.name.replace(/\.ex$/u, "") : entry.name;
      if (!entry.isDirectory() && label === entry.name) {
        continue;
      }

      const prefix = `${sourceRoot}/${label}`;
      const nested = entry.isDirectory()
        ? (await walk(root, [prefix], shouldSkipMixPath)).filter(isElixirSourceFile)
        : [];
      const rootFile = `${sourceRoot}/${label}.ex`;
      const files = [...new Set([...(await existingFiles(root, [rootFile])), ...nested])]
        .toSorted()
        .slice(0, elixirSourceGroupMaxOwnedFiles);
      if (files.length > 0) {
        const groupFiles = groups.get(label) ?? new Set<string>();
        for (const file of files) {
          groupFiles.add(file);
        }
        groups.set(label, groupFiles);
      }
    }
  }

  return [...groups.entries()]
    .map(([label, files]) => ({
      label,
      files: [...files].toSorted().slice(0, elixirSourceGroupMaxOwnedFiles),
    }))
    .toSorted((left, right) => left.label.localeCompare(right.label));
}

async function phoenixWebGroups(
  root: string,
  appName: string | null,
): Promise<ElixirSourceGroup[]> {
  const webRoot = appName === null ? null : `lib/${appName}_web`;
  const roots = webRoot !== null && (await pathExists(join(root, webRoot))) ? [webRoot] : [];
  const labels = ["controllers", "live", "plugs", "components", "channels"];
  const groups: ElixirSourceGroup[] = [];

  for (const sourceRoot of roots) {
    for (const label of labels) {
      const prefix = `${sourceRoot}/${label}`;
      const files = (await walk(root, [prefix], shouldSkipMixPath))
        .filter((path) => isElixirSourceFile(path) || path.endsWith(".heex"))
        .toSorted()
        .slice(0, elixirSourceGroupMaxOwnedFiles);
      if (files.length > 0) {
        groups.push({ label, files });
      }
    }
  }

  return groups;
}

async function safeReadDir(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

function shouldSkipMixPath(path: string): boolean {
  return shouldSkip(path) || /(^|\/)deps(\/|$)/u.test(path);
}

function isElixirSourceFile(path: string): boolean {
  return path.endsWith(".ex") || path.endsWith(".exs");
}

async function elixirTestFiles(root: string): Promise<string[]> {
  return (await walk(root, ["test"], shouldSkipMixPath))
    .filter((path) => path.endsWith("_test.exs"))
    .toSorted();
}

function associatedTests(files: string[], testFiles: string[]): SeedTestRef[] {
  const prefixes = files.flatMap(testPrefixesForSource);
  return testFiles
    .filter((path) => prefixes.some((prefix) => pathMatchesPrefix(path, prefix)))
    .slice(0, elixirTestGroupMaxFiles)
    .map((path) => ({ path, command: `mix test ${shellQuotePath(path)}` }));
}

function testPrefixesForSource(path: string): string[] {
  if (!path.startsWith("lib/")) {
    return [];
  }
  const withoutExtension = path.endsWith(".heex")
    ? path.replace(/\.[^.]+\.heex$/u, "")
    : path.replace(/\.exs?$/u, "");
  const parts = withoutExtension.split("/");
  if (parts.length < 3) {
    return [];
  }
  const app = parts[1];
  const rest = parts.slice(2);
  const testApp = app?.endsWith("_web") === true ? `${app}` : app;
  return [`test/${testApp}/${rest.join("/")}_test.exs`, `test/${testApp}/${rest[0]}`];
}

async function migrationContextFiles(root: string, appName: string | null): Promise<string[]> {
  const candidates = ["mix.exs", "lib/repo.ex"];
  if (appName !== null) {
    candidates.push(`lib/${appName}/repo.ex`);
  }

  const repoFiles = (await walk(root, ["lib"], shouldSkipMixPath))
    .filter((path) => path === "lib/repo.ex" || path.endsWith("/repo.ex"))
    .toSorted();

  return [...new Set([...(await existingFiles(root, candidates)), ...repoFiles])];
}

async function phoenixWebContextFiles(root: string, files: string[]) {
  const appWebRoot = files[0]?.split("/").slice(0, 2).join("/");
  const router = appWebRoot === undefined ? null : `${appWebRoot}/router.ex`;
  const context = router === null ? [] : await existingFiles(root, [router]);
  return context.map((path) => ({ path, reason: "Phoenix router context" }));
}

function mixTrustBoundaries(metadata: MixProjectMetadata) {
  const boundaries = new Set<string>(["filesystem", "process-exec"]);
  if (metadata.dependencies.has("ecto") || metadata.dependencies.has("ecto_sql")) {
    boundaries.add("database");
  }
  if (metadata.dependencies.has("phoenix")) {
    boundaries.add("network");
    boundaries.add("serialization");
  }
  return [...boundaries] as FeatureSeed["trustBoundaries"];
}

function contextTrustBoundaries(label: string): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>(["serialization"]);
  if (/repo|db|schema|accounts|identity|tenant|audit|security|alert/iu.test(label)) {
    boundaries.add("database");
    boundaries.add("permissions");
  }
  if (/client|api|http|ingest|satellite|webhook|sync/iu.test(label)) {
    boundaries.add("network");
    boundaries.add("external-api");
  }
  return [...boundaries];
}

function webTrustBoundaries(label: string): FeatureSeed["trustBoundaries"] {
  const boundaries = new Set<FeatureSeed["trustBoundaries"][number]>([
    "network",
    "user-input",
    "auth",
    "permissions",
    "serialization",
  ]);
  if (label === "live" || label === "controllers") {
    boundaries.add("database");
  }
  return [...boundaries];
}
