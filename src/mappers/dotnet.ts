import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { packageTrustBoundaries, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

// ── Types ──────────────────────────────────────────────────────

type DotNetLanguage = "csharp" | "fsharp" | "visual-basic";

type DotNetProjectInfo = {
  dir: string;
  projectFile: string;
  name: string;
  language: DotNetLanguage;
  outputType: "Exe" | "Library" | "WinExe";
  isTest: boolean;
  isWeb: boolean;
};

// ── Constants ──────────────────────────────────────────────────

const projectExtensions = new Map<string, DotNetLanguage>([
  [".csproj", "csharp"],
  [".fsproj", "fsharp"],
  [".vbproj", "visual-basic"],
]);

const sourceExtensions: Record<DotNetLanguage, string[]> = {
  csharp: [".cs"],
  fsharp: [".fs", ".fsi"],
  "visual-basic": [".vb"],
};

const testFrameworkPackages = new Set([
  "xunit",
  "nunit",
  "mstest",
  "tunit",
  "Microsoft.NET.Test.Sdk",
]);

// ── Skip function ──────────────────────────────────────────────

function shouldSkipDotNet(path: string): boolean {
  if (shouldSkip(path)) {
    return true;
  }
  return /(^|\/)(bin|obj)(\/|$)/u.test(path);
}

// ── Main export ────────────────────────────────────────────────

export async function dotnetSeeds(root: string): Promise<FeatureSeed[]> {
  const projects = await discoverDotNetProjects(root);
  if (projects.length === 0) {
    return [];
  }

  const testCommand = "dotnet test";
  const testProjects = projects.filter((p) => p.isTest);
  const nonTestProjects = projects.filter((p) => !p.isTest);
  const sourceCache = new Map<string, string[]>();
  for (const p of projects) {
    sourceCache.set(p.projectFile, await projectSourceFiles(root, p));
  }

  const seeds: FeatureSeed[] = [];

  for (const project of nonTestProjects) {
    const sourceFiles = sourceCache.get(project.projectFile) ?? [];
    if (sourceFiles.length === 0) {
      continue;
    }
    const entryPath = findEntryPath(project, sourceFiles);
    const tests = findAssociatedTests(project, testProjects, sourceCache);
    const isExe = project.outputType === "Exe" || project.outputType === "WinExe";
    seeds.push(
      isExe || project.isWeb
        ? dotnetExeSeed(project, entryPath, sourceFiles, tests, testCommand)
        : dotnetLibrarySeed(project, entryPath, sourceFiles, tests, testCommand),
    );
  }

  for (const tp of testProjects) {
    const files = sourceCache.get(tp.projectFile) ?? [];
    if (files.length === 0) {
      continue;
    }
    seeds.push(dotnetTestSuiteSeed(tp, files, testCommand));
  }

  return seeds;
}

// ── Project discovery ──────────────────────────────────────────

async function discoverDotNetProjects(root: string): Promise<DotNetProjectInfo[]> {
  const solutionProjects = await discoverFromSolutions(root);
  const projectPaths =
    solutionProjects.length > 0 ? solutionProjects : await discoverStandaloneProjects(root);
  return parseDotNetProjects(root, projectPaths);
}

async function discoverFromSolutions(root: string): Promise<string[]> {
  const paths = new Set<string>();
  const files = await walk(root, [""], shouldSkipDotNet);
  for (const file of files) {
    if (!file.endsWith(".sln") && !file.endsWith(".slnx")) {
      continue;
    }
    const content = await readFile(join(root, file), "utf8").catch(() => "");
    if (content.length === 0) {
      continue;
    }
    const solutionDir = file.includes("/") ? file.substring(0, file.lastIndexOf("/")) : "";
    const projects = file.endsWith(".sln")
      ? parseSlnProjects(content, solutionDir)
      : parseSlnxProjects(content, solutionDir);
    for (const p of projects) {
      paths.add(p);
    }
  }
  return [...paths].toSorted();
}

async function discoverStandaloneProjects(root: string): Promise<string[]> {
  const files = await walk(root, [""], shouldSkipDotNet);
  const exts = [...projectExtensions.keys()];
  return files.filter((f) => exts.some((ext) => f.endsWith(ext))).toSorted();
}

async function parseDotNetProjects(root: string, paths: string[]): Promise<DotNetProjectInfo[]> {
  const projects: DotNetProjectInfo[] = [];
  for (const projectPath of paths) {
    if (!(await pathExists(join(root, projectPath)))) {
      continue;
    }
    const info = await parseProjectFile(root, projectPath);
    if (info !== null) {
      projects.push(info);
    }
  }
  return projects;
}

// ── Project file parsing ───────────────────────────────────────

async function parseProjectFile(
  root: string,
  projectPath: string,
): Promise<DotNetProjectInfo | null> {
  const content = await readFile(join(root, projectPath), "utf8").catch(() => "");
  if (!content.includes("<Project")) {
    return null;
  }

  const ext = extensionOf(projectPath);
  const language = projectExtensions.get(ext);
  if (language === undefined) {
    return null;
  }

  const dir = directoryOf(projectPath);
  const name = baseNameOf(projectPath, ext);
  const outputType = extractXmlProperty(content, "OutputType") ?? "Library";
  const isWeb = /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/u.test(content);
  const packages = extractPackageReferences(content);
  const isTest = detectIsTest(name, packages);

  return {
    dir,
    projectFile: projectPath,
    name,
    language,
    outputType: outputType as DotNetProjectInfo["outputType"],
    isTest,
    isWeb,
  };
}

function extractXmlProperty(xml: string, tagName: string): string | null {
  const match = new RegExp(`<${tagName}[^>]*>\\s*([^<]+?)\\s*</${tagName}>`, "u").exec(xml);
  return match?.[1]?.trim() ?? null;
}

function extractPackageReferences(xml: string): string[] {
  return [...xml.matchAll(/<PackageReference\s+Include="([^"]+)"/gu)]
    .map((m) => m[1])
    .filter((v): v is string => v !== undefined);
}

function detectIsTest(name: string, packages: string[]): boolean {
  if (/\.(Tests?|Specs?)$/u.test(name)) {
    return true;
  }
  return packages.some((p) => testFrameworkPackages.has(p));
}

// ── Solution file parsing ──────────────────────────────────────

function parseSlnProjects(content: string, solutionDir: string): string[] {
  return [
    ...content.matchAll(/^Project\([^)]+\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.(?:cs|fs|vb)proj)"/gmu),
  ]
    .map((m) => m[1]?.replace(/\\/gu, "/"))
    .filter((v): v is string => v !== undefined && v.length > 0)
    .map((p) => resolveRelativePath(solutionDir === "" ? p : `${solutionDir}/${p}`));
}

function parseSlnxProjects(content: string, solutionDir: string): string[] {
  return [...content.matchAll(/Path="([^"]+\.(?:cs|fs|vb)proj)"/gu)]
    .map((m) => m[1]?.replace(/\\/gu, "/"))
    .filter((v): v is string => v !== undefined && v.length > 0)
    .map((p) => resolveRelativePath(solutionDir === "" ? p : `${solutionDir}/${p}`));
}

function resolveRelativePath(path: string): string {
  const parts = path.split("/");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === ".." && resolved.length > 0 && resolved.at(-1) !== "..") {
      resolved.pop();
    } else if (part !== "." && part.length > 0) {
      resolved.push(part);
    }
  }
  return resolved.join("/");
}

// ── Source file discovery ──────────────────────────────────────

async function projectSourceFiles(root: string, project: DotNetProjectInfo): Promise<string[]> {
  const exts = sourceExtensions[project.language];
  const prefix = project.dir === "." ? "" : project.dir;
  const allFiles = await walk(root, [prefix], shouldSkipDotNet);
  const projectExts = [...projectExtensions.keys()];
  return allFiles
    .filter(
      (f) => !projectExts.some((ext) => f.endsWith(ext)) && exts.some((ext) => f.endsWith(ext)),
    )
    .toSorted();
}

function findEntryPath(project: DotNetProjectInfo, files: string[]): string {
  const dir = project.dir === "." ? "" : `${project.dir}/`;
  for (const ext of sourceExtensions[project.language]) {
    const program = `${dir}Program${ext}`;
    if (files.includes(program)) {
      return program;
    }
  }
  return files[0] ?? `${dir}Program${sourceExtensions[project.language][0]}`;
}

function findAssociatedTests(
  project: DotNetProjectInfo,
  testProjects: DotNetProjectInfo[],
  sourceCache: Map<string, string[]>,
): SeedTestRef[] {
  const refs: SeedTestRef[] = [];
  for (const tp of testProjects) {
    const baseName = tp.name.replace(/\.(Tests?|Specs?)$/u, "");
    if (baseName !== project.name) {
      continue;
    }
    const files = sourceCache.get(tp.projectFile) ?? [];
    for (const tf of files.slice(0, 5)) {
      refs.push({ path: tf, command: "dotnet test" });
    }
  }
  return refs;
}

// ── Seed builders ──────────────────────────────────────────────

function dotnetExeSeed(
  project: DotNetProjectInfo,
  entryPath: string,
  sourceFiles: string[],
  tests: SeedTestRef[],
  testCommand: string,
): FeatureSeed {
  const isWeb = project.isWeb;
  return {
    title: isWeb ? `.NET web app ${project.name}` : `.NET console app ${project.name}`,
    summary: isWeb
      ? `ASP.NET Core web application at ${project.projectFile}.`
      : `.NET executable project at ${project.projectFile}.`,
    kind: isWeb ? "service" : "cli-command",
    source: isWeb ? "dotnet-web" : "dotnet-console",
    confidence: "high",
    entryPath,
    symbol: "Main",
    route: null,
    command: project.name,
    tags: ["dotnet", project.language, isWeb ? "web" : "cli"],
    trustBoundaries: isWeb
      ? ["user-input", "network", "filesystem", "process-exec"]
      : ["user-input", "filesystem", "process-exec"],
    ownedFiles: sourceFiles.map((f) => ({ path: f, reason: "dotnet project source" })),
    contextFiles: [
      { path: project.projectFile, reason: "project file" },
      ...tests.map((t) => ({ path: t.path, reason: "dotnet project test" })),
    ],
    tests,
    testCommand,
    skipNearbyTests: true,
  };
}

function dotnetLibrarySeed(
  project: DotNetProjectInfo,
  entryPath: string,
  sourceFiles: string[],
  tests: SeedTestRef[],
  testCommand: string,
): FeatureSeed {
  return {
    title: `.NET library ${project.name}`,
    summary: `.NET library project at ${project.projectFile} with ${sourceFiles.length} source file(s).`,
    kind: "library",
    source: "dotnet-library",
    confidence: "high",
    entryPath,
    symbol: null,
    route: null,
    command: null,
    tags: ["dotnet", project.language, "library"],
    trustBoundaries: packageTrustBoundaries(project.name),
    ownedFiles: sourceFiles.map((f) => ({ path: f, reason: "dotnet project source" })),
    contextFiles: [
      { path: project.projectFile, reason: "project file" },
      ...tests.map((t) => ({ path: t.path, reason: "dotnet project test" })),
    ],
    tests,
    testCommand,
    skipNearbyTests: true,
  };
}

function dotnetTestSuiteSeed(
  project: DotNetProjectInfo,
  testFiles: string[],
  testCommand: string,
): FeatureSeed {
  return {
    title: `.NET test suite ${project.name}`,
    summary: `.NET test project at ${project.projectFile} with ${testFiles.length} test file(s).`,
    kind: "test-suite",
    source: "dotnet-test",
    confidence: "medium",
    entryPath: testFiles[0] ?? project.projectFile,
    symbol: null,
    route: null,
    command: null,
    tags: ["dotnet", project.language, "test"],
    trustBoundaries: [],
    ownedFiles: testFiles.map((f) => ({ path: f, reason: "dotnet test source" })),
    contextFiles: [{ path: project.projectFile, reason: "project file" }],
    testCommand,
    skipNearbyTests: true,
  };
}

// ── Path helpers ───────────────────────────────────────────────

function directoryOf(path: string): string {
  const lastSlash = path.lastIndexOf("/");
  return lastSlash === -1 ? "." : path.substring(0, lastSlash);
}

function baseNameOf(path: string, ext: string): string {
  const lastSlash = path.lastIndexOf("/");
  const name = lastSlash === -1 ? path : path.substring(lastSlash + 1);
  return name.endsWith(ext) ? name.substring(0, name.length - ext.length) : name;
}

function extensionOf(path: string): string {
  const lastDot = path.lastIndexOf(".");
  return lastDot === -1 ? "" : path.substring(lastDot);
}
