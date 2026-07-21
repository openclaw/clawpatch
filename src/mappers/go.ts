import { spawn } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { pathExists } from "../fs.js";
import { packageKind, packageTrustBoundaries, normalize, shouldSkip } from "./shared.js";
import { FeatureSeed, MapperContext, SeedFileRef, SeedTestRef } from "./types.js";

export async function goSeeds(root: string, context: MapperContext): Promise<FeatureSeed[]> {
  if (!(await pathExists(join(root, "go.mod")))) {
    return [];
  }
  const modulePath = await goModulePath(root);
  const packages = await goPackages(root, modulePath, context);
  const packageByImport = new Map(packages.map((pkg) => [pkg.importPath, pkg]));
  const seeds: FeatureSeed[] = [];
  for (const pkg of packages) {
    const files = await goPackageFiles(root, pkg.dir);
    if (files.owned.length === 0) {
      continue;
    }
    const importedContext = await goImportContext(root, modulePath, packageByImport, files.owned);
    seeds.push(goPackageSeed(pkg, files, importedContext));
  }
  return seeds;
}

type GoPackage = {
  dir: string;
  importPath: string;
  name: string;
};

type GoPackageFiles = {
  owned: string[];
  tests: string[];
  generated: string[];
};

async function goPackages(
  root: string,
  modulePath: string | null,
  context: MapperContext,
): Promise<GoPackage[]> {
  const listed = await goListPackages(root);
  if (listed.length > 0) {
    return listed;
  }
  return fallbackGoPackages(root, modulePath, context);
}

async function goListPackages(root: string): Promise<GoPackage[]> {
  const resolvedRoot = await realpath(root).catch(() => root);
  const stdout = await runGoList(root);
  const packages: GoPackage[] = [];
  for (const line of stdout
    .split("\n")
    .map((candidate) => candidate.trim())
    .filter((candidate) => candidate.length > 0)) {
    const [dir, importPath, name] = line.split("|");
    if (dir === undefined || importPath === undefined || name === undefined) {
      continue;
    }
    const resolvedDir = await realpath(dir).catch(() => dir);
    const rel = normalize(relative(resolvedRoot, resolvedDir));
    if (rel.startsWith("..") || isAbsolute(rel) || (await isSkippedGoPackageDir(root, rel))) {
      continue;
    }
    packages.push({ dir: rel, importPath, name });
  }
  return packages;
}

async function fallbackGoPackages(
  root: string,
  modulePath: string | null,
  context: MapperContext,
): Promise<GoPackage[]> {
  const dirs = new Set<string>();
  for (const file of await context.rootFiles("go-fallback")) {
    if (!file.endsWith(".go")) {
      continue;
    }
    const dir = file.split("/").slice(0, -1).join("/");
    if (!(await isSkippedGoPackageDir(root, dir))) {
      dirs.add(dir);
    }
  }
  const packages: GoPackage[] = [];
  for (const dir of [...dirs].toSorted()) {
    packages.push({
      dir,
      importPath: modulePath === null || dir === "" ? (modulePath ?? dir) : `${modulePath}/${dir}`,
      name: await goPackageName(root, dir),
    });
  }
  return packages;
}

async function runGoList(root: string): Promise<string> {
  const child = spawn("go", ["list", "-e", "-f", "{{.Dir}}|{{.ImportPath}}|{{.Name}}", "./..."], {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  await new Promise<void>((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
  return stdout;
}

async function isSkippedGoPackageDir(root: string, dir: string): Promise<boolean> {
  if (shouldSkip(dir) || hasIgnoredGoDirComponent(dir)) {
    return true;
  }
  return hasNestedGoMod(root, dir);
}

function hasIgnoredGoDirComponent(dir: string): boolean {
  return dir
    .split("/")
    .filter((part) => part.length > 0)
    .some(
      (part) =>
        part === "vendor" || part === "testdata" || part.startsWith(".") || part.startsWith("_"),
    );
}

async function hasNestedGoMod(root: string, dir: string): Promise<boolean> {
  const parts = dir.split("/").filter((part) => part.length > 0);
  for (let index = 1; index <= parts.length; index += 1) {
    if (await pathExists(join(root, parts.slice(0, index).join("/"), "go.mod"))) {
      return true;
    }
  }
  return false;
}

async function goPackageFiles(root: string, dir: string): Promise<GoPackageFiles> {
  const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".go"))
    .map((entry) => normalize(join(dir, entry.name)));
  const owned: string[] = [];
  const tests: string[] = [];
  const generated: string[] = [];
  for (const file of files) {
    if (file.endsWith("_test.go")) {
      tests.push(file);
      continue;
    }
    if (await isGeneratedGoFile(root, file)) {
      generated.push(file);
      continue;
    }
    owned.push(file);
  }
  return {
    owned: owned.toSorted(),
    tests: tests.toSorted(),
    generated: generated.toSorted(),
  };
}

async function isGeneratedGoFile(root: string, file: string): Promise<boolean> {
  if (/(^|\/)(.*\.pb\.go|.*_gen\.go|.*_generated\.go|.*\.sql\.go|.*_sqlc\.go)$/u.test(file)) {
    return true;
  }
  const head = (await readFile(join(root, file), "utf8")).slice(0, 2_000);
  return /Code generated .* DO NOT EDIT\.|DO NOT EDIT: generated/iu.test(head);
}

async function goImportContext(
  root: string,
  modulePath: string | null,
  packages: Map<string, GoPackage>,
  files: string[],
): Promise<SeedFileRef[]> {
  if (modulePath === null) {
    return [];
  }
  const refs: SeedFileRef[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const source = await readFile(join(root, file), "utf8");
    for (const imported of goImports(source)) {
      if (imported !== modulePath && !imported.startsWith(`${modulePath}/`)) {
        continue;
      }
      const pkg = packages.get(imported);
      if (pkg === undefined) {
        continue;
      }
      for (const contextFile of (await goPackageFiles(root, pkg.dir)).owned) {
        if (seen.has(contextFile)) {
          continue;
        }
        seen.add(contextFile);
        refs.push({ path: contextFile, reason: `imported package ${imported}` });
        if (refs.length >= 24) {
          return refs;
        }
      }
    }
  }
  return refs;
}

function goPackageSeed(
  pkg: GoPackage,
  files: GoPackageFiles,
  importedContext: SeedFileRef[],
): FeatureSeed {
  const commandName = pkg.name === "main" ? goCommandName(pkg.dir) : null;
  const isCommand = pkg.name === "main";
  const name = commandName ?? (pkg.dir === "" ? pkg.name : (pkg.dir.split("/").at(-1) ?? pkg.dir));
  const entryPath =
    files.owned.find((file) => file === "main.go" || file.endsWith("/main.go")) ??
    files.owned[0] ??
    pkg.dir;
  const tests: SeedTestRef[] = files.tests.map((path) => ({ path, command: "go test ./..." }));
  const generatedContext = files.generated.map((path) => ({ path, reason: "generated go file" }));
  return {
    title: isCommand ? `Go command ${name}` : `Go package ${name}`,
    summary: isCommand
      ? `Go command package ${pkg.dir} with ${files.owned.length} source file(s).`
      : `Go package ${pkg.dir} with ${files.owned.length} source file(s).`,
    kind: isCommand ? "cli-command" : packageKind(name),
    source:
      commandName !== null
        ? "go-cmd"
        : pkg.dir === ""
          ? "go-root-package"
          : pkg.dir.startsWith("internal/")
            ? "go-internal-package"
            : "go-package",
    confidence: "medium",
    entryPath,
    symbol: isCommand ? "main" : null,
    route: null,
    command: commandName,
    tags: isCommand ? ["go", "cli"] : ["go", "package"],
    trustBoundaries: isCommand
      ? ["user-input", "filesystem", "process-exec", "network"]
      : packageTrustBoundaries(name),
    ownedFiles: entryFirst(files.owned, entryPath).map((path) => ({
      path,
      reason: "go package source",
    })),
    contextFiles: [
      ...tests.map((test) => ({ path: test.path, reason: "go package test" })),
      ...generatedContext,
      ...importedContext,
    ],
    tests,
    testCommand: "go test ./...",
  };
}

function entryFirst(files: string[], entryPath: string): string[] {
  return [entryPath, ...files.filter((file) => file !== entryPath)];
}

function goCommandName(dir: string): string | null {
  const parts = dir.split("/");
  return parts.length === 2 && parts[0] === "cmd" && parts[1] !== undefined ? parts[1] : null;
}

async function goPackageName(root: string, dir: string): Promise<string> {
  const files = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".go") || file.name.endsWith("_test.go")) {
      continue;
    }
    const source = await readFile(join(root, dir, file.name), "utf8").catch(() => "");
    const name = /^\s*package\s+([A-Za-z_][A-Za-z0-9_]*)/mu.exec(source)?.[1];
    if (name !== undefined) {
      return name;
    }
  }
  return dir === "" ? "main" : (dir.split("/").at(-1) ?? dir);
}

async function goModulePath(root: string): Promise<string | null> {
  const source = await readFile(join(root, "go.mod"), "utf8").catch(() => "");
  return /^module\s+(\S+)/mu.exec(source)?.[1] ?? null;
}

function goImports(source: string): string[] {
  const imports = new Set<string>();
  for (const match of source.matchAll(
    /^\s*import\s+(?:[._A-Za-z][A-Za-z0-9_.]*\s+)?"([^"]+)"/gmu,
  )) {
    if (match[1] !== undefined) {
      imports.add(match[1]);
    }
  }
  for (const block of source.matchAll(/^\s*import\s*\(([\s\S]*?)\)/gmu)) {
    for (const match of (block[1] ?? "").matchAll(/"([^"]+)"/gu)) {
      if (match[1] !== undefined) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports];
}
