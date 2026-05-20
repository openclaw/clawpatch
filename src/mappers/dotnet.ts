import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { shellQuotePath } from "../shell.js";
import { TrustBoundary } from "../types.js";
import { partitionFileGroups } from "./grouping.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";

const maxOwnedFiles = 12;
const maxTests = 8;

type DotnetProject = {
  path: string;
  root: string;
  name: string;
  language: "csharp" | "fsharp" | "visual-basic";
  sdk: string | null;
  source: string;
  packageReferences: string[];
  frameworkReferences: string[];
  projectReferences: string[];
  isTest: boolean;
  isStrongTest: boolean;
  isWeb: boolean;
  isWorker: boolean;
  sourceFiles: string[];
};

type DotnetSolution = {
  path: string;
  projectPaths: string[];
};

export async function dotnetSeeds(root: string): Promise<FeatureSeed[]> {
  const files = await walk(root, [""], shouldSkipDotnetPath);
  const fileSet = new Set(files);
  const solutions = await dotnetSolutions(root, files.filter(isDotnetSolutionPath));
  const projectPaths = uniqueStrings([
    ...files.filter(isDotnetProjectPath),
    ...solutions.flatMap((solution) => solution.projectPaths),
  ]).filter((path) => fileSet.has(path));
  const sourceFiles = files
    .filter(isDotnetSourcePath)
    .filter((path) => !isGeneratedDotnetSourcePath(path));
  if (projectPaths.length === 0 && sourceFiles.length === 0) {
    return [];
  }

  const configs = dotnetConfigFiles(files);
  if (projectPaths.length === 0) {
    return sourceOnlyCsharpSeeds(sourceFiles, configs);
  }

  const projects = await dotnetProjects(root, projectPaths, sourceFiles);
  const solutionContextsByProject = solutionContextsByProjectPath(solutions);
  const testProjects = projects.filter((project) => project.isTest);
  const routeOwnedFiles = new Set<string>();
  const seeds: FeatureSeed[] = [];

  for (const project of projects) {
    seeds.push(
      projectSeed(project, configs, solutionContextsByProject.get(project.path) ?? [], projects),
    );
  }

  for (const project of testProjects) {
    seeds.push(...testProjectSeeds(project, configs));
  }

  for (const project of projects.filter((candidate) => candidate.language === "csharp")) {
    if (project.isTest) {
      continue;
    }
    const tests = associatedTests(project, testProjects);
    for (const seed of await aspNetRouteSeeds(root, project, tests)) {
      for (const owned of seed.ownedFiles ?? []) {
        routeOwnedFiles.add(owned.path);
      }
      seeds.push(seed);
    }
  }

  for (const project of projects) {
    if (project.isTest) {
      continue;
    }
    const groupSourceFiles =
      project.language === "csharp"
        ? project.sourceFiles.filter((path) => !routeOwnedFiles.has(path))
        : project.sourceFiles;
    const tests = associatedTests(project, testProjects);
    for (const group of dotnetSourceGroups(project, groupSourceFiles)) {
      seeds.push(sourceGroupSeed(project, group, tests));
    }
  }

  return seeds;
}

async function dotnetProjects(
  root: string,
  projectPaths: string[],
  sourceFiles: string[],
): Promise<DotnetProject[]> {
  const projects = await Promise.all(
    projectPaths.toSorted().map((path) => readDotnetProject(root, path)),
  );
  const projectRoots = projects.map((project) => ({ path: project.path, root: project.root }));
  const knownProjectPaths = new Set(projects.map((project) => project.path));
  return projects.map((project) => ({
    ...project,
    projectReferences: project.projectReferences.filter((path) => knownProjectPaths.has(path)),
    sourceFiles: projectSourceFiles(project, sourceFiles, projectRoots),
  }));
}

async function dotnetSolutions(root: string, paths: string[]): Promise<DotnetSolution[]> {
  const solutions: DotnetSolution[] = [];
  for (const path of paths.toSorted()) {
    const source = await readFile(join(root, path), "utf8").catch(() => "");
    const solutionRoot = projectRoot(path);
    const projectPaths = isDotnetSlnxPath(path)
      ? slnxProjectPaths(source, solutionRoot)
      : slnProjectPaths(source, solutionRoot);
    solutions.push({ path, projectPaths });
  }
  return solutions;
}

function solutionContextsByProjectPath(solutions: DotnetSolution[]): Map<string, SeedFileRef[]> {
  const byProject = new Map<string, SeedFileRef[]>();
  for (const solution of solutions) {
    for (const projectPath of solution.projectPaths) {
      const refs = byProject.get(projectPath) ?? [];
      refs.push({ path: solution.path, reason: "solution context" });
      byProject.set(projectPath, refs);
    }
  }
  return byProject;
}

function slnProjectPaths(source: string, solutionRoot: string): string[] {
  const paths: string[] = [];
  const pattern = /^Project\([^)]+\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.(?:cs|fs|vb)proj)"/gimu;
  for (const match of source.matchAll(pattern)) {
    const path = solutionProjectPath(solutionRoot, match[1] ?? "");
    if (path !== null) {
      paths.push(path);
    }
  }
  return uniqueStrings(paths).toSorted();
}

function slnxProjectPaths(source: string, solutionRoot: string): string[] {
  const paths: string[] = [];
  const activeSource = stripXmlComments(source);
  for (const match of activeSource.matchAll(
    /\bPath\s*=\s*["']([^"']+\.(?:cs|fs|vb)proj)["']/gimu,
  )) {
    const path = solutionProjectPath(solutionRoot, match[1] ?? "");
    if (path !== null) {
      paths.push(path);
    }
  }
  return uniqueStrings(paths).toSorted();
}

function solutionProjectPath(solutionRoot: string, path: string): string | null {
  const normalized = normalizeMsbuildPath(path);
  if (normalized.length === 0 || /^(?:[A-Za-z]:)?\//u.test(normalized)) {
    return null;
  }
  const resolved = normalize(join(solutionRoot === "." ? "" : solutionRoot, normalized));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    return null;
  }
  return resolved;
}

async function readDotnetProject(root: string, path: string): Promise<DotnetProject> {
  const source = await readFile(join(root, path), "utf8").catch(() => "");
  const activeSource = stripXmlComments(source);
  const name =
    xmlElementValue(activeSource, "AssemblyName") ??
    xmlElementValue(activeSource, "RootNamespace") ??
    basename(path, extname(path));
  const packageReferences = xmlAttributeValues(activeSource, "PackageReference", "Include");
  const frameworkReferences = xmlAttributeValues(activeSource, "FrameworkReference", "Include");
  const sdk = dotnetProjectSdk(activeSource);
  const projectReferences = xmlAttributeValues(activeSource, "ProjectReference", "Include").map(
    (ref) => normalize(join(dirname(path), normalizeMsbuildPath(ref))),
  );
  const strongTest = isStrongTestProject(activeSource);
  return {
    path,
    root: projectRoot(path),
    name,
    language: projectLanguage(path),
    sdk,
    source: activeSource,
    packageReferences,
    frameworkReferences,
    projectReferences,
    isTest: strongTest || isLikelyTestProjectPath(path),
    isStrongTest: strongTest,
    isWeb: isWebProject(activeSource, packageReferences, frameworkReferences),
    isWorker: isWorkerProject(activeSource, packageReferences),
    sourceFiles: [],
  };
}

function projectSeed(
  project: DotnetProject,
  configs: SeedFileRef[],
  solutions: SeedFileRef[],
  projects: DotnetProject[],
): FeatureSeed {
  const referenceContext = project.projectReferences
    .filter((path) => projects.some((candidate) => candidate.path === path))
    .map((path) => ({ path, reason: "project reference" }));
  return {
    title: `.NET project ${project.name}`,
    summary: `${dotnetLanguageName(project.language)} project ${project.path}.`,
    kind: projectKind(project),
    source: "dotnet-project",
    confidence: project.language === "csharp" ? "high" : "medium",
    entryPath: project.path,
    symbol: project.name,
    route: null,
    command: null,
    ownedFiles: [{ path: project.path, reason: "project file" }],
    contextFiles: uniqueFileRefs([...configs, ...solutions, ...referenceContext]),
    tags: projectTags(project, "project"),
    trustBoundaries: projectTrustBoundaries(project),
    skipNearbyTests: true,
  };
}

function testProjectSeeds(project: DotnetProject, configs: SeedFileRef[]): FeatureSeed[] {
  const groups =
    project.sourceFiles.length === 0
      ? [{ label: project.name, files: [] }]
      : dotnetSourceGroups(project, project.sourceFiles);
  const multipleGroups = groups.length > 1;
  return groups.map((group) => {
    const languageName = dotnetLanguageName(project.language);
    const tests = testRefsForFiles(project, group.files);
    const ownedFiles =
      group.files.length === 0
        ? [{ path: project.path, reason: "test project file" }]
        : group.files.map((path) => ({
            path,
            reason: `${languageName} test group ${group.label}`,
          }));
    return {
      title: multipleGroups
        ? `${languageName} test suite ${group.label}`
        : `${languageName} test suite ${project.name}`,
      summary:
        group.files.length === 0
          ? `${languageName} test project ${project.path}.`
          : `${languageName} test group ${group.label} with ${group.files.length} source file(s).`,
      kind: "test-suite",
      source: "dotnet-test-project",
      confidence: project.isStrongTest ? "high" : "medium",
      entryPath: group.files[0] ?? project.path,
      symbol: multipleGroups ? group.label : project.name,
      route: null,
      command: null,
      ownedFiles,
      contextFiles: uniqueFileRefs([
        { path: project.path, reason: "test project file" },
        ...configs,
      ]),
      tests,
      tags: projectTags(project, "test"),
      trustBoundaries: [],
      testCommand: dotnetTestCommand(project),
      skipNearbyTests: true,
    };
  });
}

async function aspNetRouteSeeds(
  root: string,
  project: DotnetProject,
  tests: SeedTestRef[],
): Promise<FeatureSeed[]> {
  if (!project.isWeb && !project.sourceFiles.some((path) => isAspNetRouteConventionPath(path))) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  for (const path of project.sourceFiles) {
    const source = stripCsharpComments(await readFile(join(root, path), "utf8").catch(() => ""));
    const controller = controllerInfo(path, source);
    if (controller !== null) {
      seeds.push(controllerSeed(project, path, controller, tests));
      continue;
    }
    for (const endpoint of minimalApiEndpoints(source)) {
      seeds.push(minimalApiSeed(project, path, endpoint, tests));
    }
  }
  return seeds;
}

function controllerSeed(
  project: DotnetProject,
  path: string,
  controller: { name: string; routes: string[] },
  tests: SeedTestRef[],
): FeatureSeed {
  const route = controller.routes[0] ?? null;
  return {
    title: `ASP.NET controller ${controller.name}`,
    summary:
      controller.routes.length === 0
        ? `ASP.NET controller ${controller.name} in ${path}.`
        : `ASP.NET controller ${controller.name} in ${path}; routes ${controller.routes.join(", ")}.`,
    kind: "route",
    source: "dotnet-aspnet-controller",
    confidence: controller.routes.length === 0 ? "medium" : "high",
    entryPath: path,
    identityKey: controller.name,
    symbol: controller.name,
    route,
    command: null,
    ownedFiles: [{ path, reason: "ASP.NET controller" }],
    contextFiles: routeContextFiles(project, tests),
    tests,
    tags: projectTags(project, "aspnet", "controller"),
    trustBoundaries: aspNetTrustBoundaries(route, path),
    testCommand: tests[0]?.command ?? null,
    skipNearbyTests: true,
  };
}

function minimalApiSeed(
  project: DotnetProject,
  path: string,
  endpoint: { method: string; route: string },
  tests: SeedTestRef[],
): FeatureSeed {
  const method = endpoint.method === "METHODS" ? "HTTP" : endpoint.method;
  return {
    title: `ASP.NET endpoint ${method} ${endpoint.route}`,
    summary: `ASP.NET minimal API endpoint ${method} ${endpoint.route} in ${path}.`,
    kind: "route",
    source: "dotnet-minimal-api-route",
    confidence: "high",
    entryPath: path,
    identityKey: `${method}:${endpoint.route}`,
    symbol: null,
    route: endpoint.route,
    command: null,
    ownedFiles: [{ path, reason: "ASP.NET minimal API endpoint" }],
    contextFiles: routeContextFiles(project, tests),
    tests,
    tags: projectTags(project, "aspnet", "minimal-api"),
    trustBoundaries: aspNetTrustBoundaries(endpoint.route, path),
    testCommand: tests[0]?.command ?? null,
    skipNearbyTests: true,
  };
}

function sourceGroupSeed(
  project: DotnetProject,
  group: { label: string; files: string[] },
  tests: SeedTestRef[],
): FeatureSeed {
  const kind = sourceGroupKind(project, group.label);
  const languageName = dotnetLanguageName(project.language);
  return {
    title: `${languageName} source ${group.label}`,
    summary:
      group.files.length === 1
        ? `${languageName} source file ${group.files[0]} in project ${project.name}.`
        : `${languageName} source group ${group.label} with ${group.files.length} files in project ${project.name}.`,
    kind,
    source: "dotnet-source-group",
    confidence: "medium",
    entryPath: group.files[0] ?? project.path,
    symbol: group.label,
    route: null,
    command: null,
    ownedFiles: group.files.map((path) => ({
      path,
      reason: `${languageName} source group ${group.label}`,
    })),
    contextFiles: sourceContextFiles(project, tests),
    tests,
    tags: projectTags(project, "source-group"),
    trustBoundaries: sourceGroupTrustBoundaries(project, group.label),
    testCommand: tests[0]?.command ?? null,
    skipNearbyTests: true,
  };
}

function sourceOnlyCsharpSeeds(sourceFiles: string[], configs: SeedFileRef[]): FeatureSeed[] {
  return sourceOnlyCsharpGroups(
    sourceFiles.filter((path) => isProjectLanguageSourcePath(path, "csharp")),
  ).map((group) => sourceOnlyCsharpSeed(group, configs));
}

function sourceOnlyCsharpSeed(
  group: { label: string; files: string[] },
  configs: SeedFileRef[],
): FeatureSeed {
  return {
    title: `C# source ${group.label}`,
    summary:
      group.files.length === 1
        ? `C# source file ${group.files[0]} without a .NET project file.`
        : `C# source group ${group.label} with ${group.files.length} files without a .NET project file.`,
    kind: sourceOnlyCsharpKind(group.label),
    source: "dotnet-csharp-source-only",
    confidence: "medium",
    entryPath: group.files[0] ?? "",
    symbol: group.label,
    route: null,
    command: null,
    ownedFiles: group.files.map((path) => ({
      path,
      reason: `C# source group ${group.label}`,
    })),
    contextFiles: configs,
    tests: [],
    tags: ["dotnet", "csharp", "source-only", "source-group"],
    trustBoundaries: sourceOnlyCsharpTrustBoundaries(group.label, group.files),
    testCommand: null,
    skipNearbyTests: true,
  };
}

function dotnetSourceGroups(
  project: DotnetProject,
  files: string[],
): Array<{ label: string; files: string[] }> {
  if (files.length === 0) {
    return [];
  }
  const sorted = files.toSorted();
  if (project.root !== ".") {
    return partitionFileGroups(project.root, sorted, maxOwnedFiles);
  }
  const topLevelSegments = new Set(sorted.map((path) => path.split("/")[0] ?? path));
  if (topLevelSegments.size === 1) {
    const root = sorted[0]?.split("/")[0];
    if (root !== undefined && sorted.every((path) => path.startsWith(`${root}/`))) {
      return partitionFileGroups(root, sorted, maxOwnedFiles);
    }
  }
  const groups: Array<{ label: string; files: string[] }> = [];
  for (let index = 0; index < sorted.length; index += maxOwnedFiles) {
    groups.push({
      label:
        index === 0 ? project.name : `${project.name}#${Math.floor(index / maxOwnedFiles) + 1}`,
      files: sorted.slice(index, index + maxOwnedFiles),
    });
  }
  return groups;
}

function sourceOnlyCsharpGroups(files: string[]): Array<{ label: string; files: string[] }> {
  if (files.length === 0) {
    return [];
  }
  const sorted = files.toSorted();
  const topLevelSegments = new Set(sorted.map((path) => path.split("/")[0] ?? path));
  if (topLevelSegments.size === 1) {
    const root = sorted[0]?.split("/")[0];
    if (root !== undefined && sorted.every((path) => path.startsWith(`${root}/`))) {
      return partitionFileGroups(root, sorted, maxOwnedFiles);
    }
  }
  const groups: Array<{ label: string; files: string[] }> = [];
  for (let index = 0; index < sorted.length; index += maxOwnedFiles) {
    groups.push({
      label: index === 0 ? "repository" : `repository#${Math.floor(index / maxOwnedFiles) + 1}`,
      files: sorted.slice(index, index + maxOwnedFiles),
    });
  }
  return groups;
}

function projectSourceFiles(
  project: DotnetProject,
  sourceFiles: string[],
  projectRoots: Array<{ path: string; root: string }>,
): string[] {
  return sourceFiles
    .filter((path) => isProjectLanguageSourcePath(path, project.language))
    .filter((path) => fileBelongsToProject(path, project, projectRoots))
    .filter((path) => !isGeneratedDotnetSourcePath(path))
    .toSorted();
}

function fileBelongsToProject(
  path: string,
  project: DotnetProject,
  projectRoots: Array<{ path: string; root: string }>,
): boolean {
  if (project.root !== "." && !pathMatchesPrefix(path, project.root)) {
    return false;
  }
  for (const other of projectRoots) {
    if (other.path === project.path || other.root === "." || other.root === project.root) {
      continue;
    }
    const nestedInProject = project.root === "." || pathMatchesPrefix(other.root, project.root);
    if (nestedInProject && pathMatchesPrefix(path, other.root)) {
      return false;
    }
  }
  return true;
}

function associatedTests(project: DotnetProject, testProjects: DotnetProject[]): SeedTestRef[] {
  const tests: SeedTestRef[] = [];
  for (const testProject of testProjects) {
    if (!testProjectTargetsProject(testProject, project)) {
      continue;
    }
    tests.push(...testRefs(testProject));
  }
  return tests.slice(0, maxTests);
}

function testProjectTargetsProject(testProject: DotnetProject, project: DotnetProject): boolean {
  if (testProject.projectReferences.includes(project.path)) {
    return true;
  }
  const testName = normalizeName(testProject.name);
  const projectName = normalizeName(project.name);
  return (
    testName === `${projectName}tests` ||
    testName === `${projectName}test` ||
    testName.startsWith(`${projectName}tests`) ||
    testName.startsWith(`${projectName}test`)
  );
}

function testRefs(project: DotnetProject): SeedTestRef[] {
  return testRefsForFiles(project, project.sourceFiles);
}

function testRefsForFiles(project: DotnetProject, files: string[]): SeedTestRef[] {
  const command = dotnetTestCommand(project);
  if (files.length === 0) {
    return [{ path: project.path, command }];
  }
  return files.map((path) => ({ path, command }));
}

function dotnetTestCommand(project: DotnetProject): string {
  return `dotnet test ${shellQuotePath(project.path)}`;
}

function dotnetConfigFiles(files: string[]): SeedFileRef[] {
  return files.filter(isDotnetConfigPath).map((path) => ({ path, reason: "dotnet config" }));
}

function routeContextFiles(project: DotnetProject, tests: SeedTestRef[]): SeedFileRef[] {
  return uniqueFileRefs([
    { path: project.path, reason: "project file" },
    ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
  ]);
}

function sourceContextFiles(project: DotnetProject, tests: SeedTestRef[]): SeedFileRef[] {
  return uniqueFileRefs([
    { path: project.path, reason: "project file" },
    ...project.projectReferences.map((path) => ({ path, reason: "project reference" })),
    ...tests.map((test) => ({ path: test.path, reason: "associated test" })),
  ]);
}

function projectKind(project: DotnetProject): FeatureSeed["kind"] {
  if (project.isTest) {
    return "test-suite";
  }
  if (project.isWeb || project.isWorker) {
    return "service";
  }
  return "library";
}

function sourceGroupKind(project: DotnetProject, label: string): FeatureSeed["kind"] {
  if (/(^|\/)(jobs?|workers?|background|hostedservices?)(\/|$)/iu.test(label)) {
    return "job";
  }
  if (
    project.isWeb ||
    /(^|\/)(services?|data|repositories|persistence|clients?)(\/|$)/iu.test(label)
  ) {
    return "service";
  }
  return "library";
}

function sourceOnlyCsharpKind(label: string): FeatureSeed["kind"] {
  if (/(^|\/)(jobs?|workers?|background|hostedservices?)(\/|$)/iu.test(label)) {
    return "job";
  }
  if (/(^|\/)(services?|data|repositories|persistence|clients?)(\/|$)/iu.test(label)) {
    return "service";
  }
  return "library";
}

function projectTrustBoundaries(project: DotnetProject): TrustBoundary[] {
  const boundaries: TrustBoundary[] = [];
  if (project.isWeb) {
    boundaries.push("network", "user-input", "serialization");
  }
  if (project.isWorker) {
    boundaries.push("filesystem", "process-exec");
  }
  if (hasDatabaseEvidence(project.path, project.source)) {
    boundaries.push("database", "serialization");
  }
  return uniqueStrings(boundaries) as TrustBoundary[];
}

function sourceGroupTrustBoundaries(project: DotnetProject, label: string): TrustBoundary[] {
  const boundaries = projectTrustBoundaries(project);
  if (/(^|\/)(data|repositories|persistence|migrations)(\/|$)/iu.test(label)) {
    boundaries.push("database", "serialization");
  }
  if (/(^|\/)(clients?|http|external|integrations?)(\/|$)/iu.test(label)) {
    boundaries.push("network", "external-api", "serialization");
  }
  if (/(^|\/)(auth|identity|security|permissions?)(\/|$)/iu.test(label)) {
    boundaries.push("auth", "permissions");
  }
  return uniqueStrings(boundaries) as TrustBoundary[];
}

function sourceOnlyCsharpTrustBoundaries(label: string, files: string[]): TrustBoundary[] {
  const boundaries: TrustBoundary[] = [];
  const evidence = `${label}\n${files.join("\n")}`;
  if (/(^|\/)(data|repositories|persistence|migrations)(\/|$)/iu.test(evidence)) {
    boundaries.push("database", "serialization");
  }
  if (/(^|\/)(clients?|http|external|integrations?)(\/|$)/iu.test(evidence)) {
    boundaries.push("network", "external-api", "serialization");
  }
  if (/(^|\/)(auth|identity|security|permissions?)(\/|$)/iu.test(evidence)) {
    boundaries.push("auth", "permissions");
  }
  return uniqueStrings(boundaries) as TrustBoundary[];
}

function aspNetTrustBoundaries(route: string | null, path: string): TrustBoundary[] {
  const boundaries: TrustBoundary[] = ["network", "user-input", "serialization"];
  if (/auth|login|token|admin|permission/iu.test(`${route ?? ""} ${path}`)) {
    boundaries.push("auth", "permissions");
  }
  return uniqueStrings(boundaries) as TrustBoundary[];
}

function projectTags(project: DotnetProject, ...extra: string[]): string[] {
  return uniqueStrings([
    "dotnet",
    project.language,
    `project:${project.name}`,
    `project-root:${project.root}`,
    ...(project.sdk === null ? [] : [`sdk:${project.sdk}`]),
    ...(project.isWeb ? ["aspnetcore"] : []),
    ...(project.isWorker ? ["worker"] : []),
    ...extra,
  ]);
}

function controllerInfo(path: string, source: string): { name: string; routes: string[] } | null {
  const classMatch = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*Controller)\b[^{}\n]*(?:[^{]+)?\{/u.exec(
    source,
  );
  if (classMatch?.[1] === undefined && !isAspNetConventionPath(path)) {
    return null;
  }
  const name = classMatch?.[1] ?? basename(path, ".cs");
  if (
    !/\b(ApiController|ControllerBase|Controller)\b/u.test(source) &&
    !name.endsWith("Controller")
  ) {
    return null;
  }
  return { name, routes: routeAttributes(source) };
}

function routeAttributes(source: string): string[] {
  const routes: string[] = [];
  const pattern =
    /\[\s*(?:Route|HttpGet|HttpPost|HttpPut|HttpPatch|HttpDelete|HttpHead|HttpOptions)\b/gu;
  for (const match of source.matchAll(pattern)) {
    const route = routeTemplateFromAttributeTail(
      readAttributeTail(source, match.index + match[0].length),
    );
    if (route !== null) {
      routes.push(route);
    }
  }
  return uniqueStrings(routes);
}

function readAttributeTail(source: string, start: number): string {
  let output = "";
  let quote: "normal" | "verbatim" | null = null;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += char;
      if (quote === "verbatim") {
        if (char === '"' && next === '"') {
          output += next;
          index += 1;
        } else if (char === '"') {
          quote = null;
        }
      } else if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        quote = null;
      }
      continue;
    }
    if (char === "@" && next === '"') {
      output += char;
      output += next;
      index += 1;
      quote = "verbatim";
    } else if (char === '"') {
      output += char;
      quote = "normal";
    } else if (char === "]") {
      return output;
    } else {
      output += char;
    }
  }
  return output;
}

function routeTemplateFromAttributeTail(tail: string): string | null {
  const open = tail.indexOf("(");
  const close = tail.lastIndexOf(")");
  if (open === -1 || close <= open) {
    return null;
  }
  const args = tail.slice(open + 1, close);
  const positional = /^\s*@?"((?:[^"]|"")*)"/u.exec(args)?.[1];
  const namedTemplate = /^\s*(?:template|path)\s*:\s*@?"((?:[^"]|"")*)"/iu.exec(args)?.[1];
  const route = positional ?? namedTemplate ?? null;
  return route === null ? null : normalizeAspNetRoute(route);
}

function minimalApiEndpoints(source: string): Array<{ method: string; route: string }> {
  const endpoints: Array<{ method: string; route: string }> = [];
  const routeGroups = routeGroupPrefixes(source);
  const pattern =
    /\.\s*Map(Get|Post|Put|Patch|Delete|Methods|Fallback|FallbackToFile)\s*\(\s*@?"((?:[^"]|"")*)"/gu;
  for (const match of source.matchAll(pattern)) {
    const method = match[1]?.toUpperCase() ?? "HTTP";
    if (method === "FALLBACKTOFILE" && !hasFollowingStringArgument(source, match)) {
      continue;
    }
    const route = normalizeAspNetRoute(match[2] ?? "");
    if (route === null) {
      continue;
    }
    endpoints.push({
      method,
      route: combineAspNetRoutes([
        ...routeGroupPrefixesForEndpoint(source, match, routeGroups),
        route,
      ]),
    });
  }
  return endpoints;
}

function routeGroupPrefixes(source: string): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  const factories = routeGroupFactoryPrefixes(source);
  const assignmentPattern = /\b(?:var\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/gu;
  for (const match of source.matchAll(assignmentPattern)) {
    const name = match[1];
    const expression = match[2];
    if (name === undefined || expression === undefined) {
      continue;
    }
    const prefixes = routeGroupPrefixesFromExpression(expression, groups, factories);
    if (prefixes.length > 0) {
      groups.set(name, prefixes);
    }
  }
  return groups;
}

function routeGroupFactoryPrefixes(source: string): Map<string, string[]> {
  const factories = new Map<string, string[]>();
  const expressionBodyPattern =
    /\b([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*=>\s*([^;]*\.\s*MapGroup\s*\([^;]*);/gu;
  for (const match of source.matchAll(expressionBodyPattern)) {
    const name = match[1];
    const expression = match[2];
    if (name === undefined || expression === undefined) {
      continue;
    }
    const prefixes = routeGroupPrefixesFromExpression(expression, new Map(), factories);
    if (prefixes.length > 0) {
      factories.set(name, prefixes);
    }
  }
  return factories;
}

function routeGroupPrefixesForEndpoint(
  source: string,
  match: RegExpMatchArray,
  groups: Map<string, string[]>,
): string[] {
  const matchIndex = match.index ?? 0;
  const statementStart = source.lastIndexOf(";", matchIndex) + 1;
  return routeGroupPrefixesFromExpression(source.slice(statementStart, matchIndex), groups);
}

function routeGroupPrefixesFromExpression(
  expression: string,
  groups: Map<string, string[]>,
  factories: Map<string, string[]> = new Map(),
): string[] {
  const leadingName = /^\s*([A-Za-z_][A-Za-z0-9_]*)\b/u.exec(expression)?.[1] ?? "";
  const prefixes = [...(groups.get(leadingName) ?? [])];
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*\s*\(/u.test(expression)) {
    prefixes.push(...(factories.get(leadingName) ?? []));
  }
  const groupPattern = /\.\s*MapGroup\s*\(\s*@?"((?:[^"]|"")*)"/gu;
  for (const match of expression.matchAll(groupPattern)) {
    const route = normalizeAspNetRoute(match[1] ?? "");
    if (route !== null) {
      prefixes.push(route);
    }
  }
  return prefixes;
}

function hasFollowingStringArgument(source: string, match: RegExpMatchArray): boolean {
  return /^,\s*(?:filePath\s*:\s*)?@?"/u.test(source.slice((match.index ?? 0) + match[0].length));
}

function combineAspNetRoutes(parts: string[]): string {
  const segments = parts.map((part) => part.replace(/^\/+|\/+$/gu, "")).filter(Boolean);
  return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function normalizeAspNetRoute(route: string): string | null {
  const cleaned = route.replace(/""/gu, '"').replace(/^~?\//u, "/");
  if (cleaned.length === 0) {
    return "/";
  }
  if (cleaned.includes("[") || cleaned.includes("]")) {
    return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
  }
  return cleaned.startsWith("/") ? cleaned : `/${cleaned}`;
}

function stripCsharpComments(source: string): string {
  let output = "";
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote !== null) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
    } else if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") {
        output += " ";
        index += 1;
      }
      output += "\n";
    } else if (char === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      output += "  ";
      index += 1;
    } else {
      output += char;
    }
  }
  return output;
}

function dotnetProjectSdk(source: string): string | null {
  return (
    /<Project\b[^>]*\bSdk\s*=\s*["']([^"']+)["']/iu.exec(source)?.[1] ??
    /<Sdk\b[^>]*\bName\s*=\s*["']([^"']+)["']/iu.exec(source)?.[1] ??
    null
  );
}

function xmlElementValue(source: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`<${escapedName}>\\s*([^<]+?)\\s*</${escapedName}>`, "iu").exec(source)?.[1] ?? null
  );
}

function xmlAttributeValues(source: string, element: string, attribute: string): string[] {
  const values: string[] = [];
  const elementName = element.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const attributeName = attribute.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(
    `<${elementName}\\b[^>]*\\b${attributeName}\\s*=\\s*["']([^"']+)["']`,
    "giu",
  );
  for (const match of source.matchAll(pattern)) {
    if (match[1] !== undefined) {
      values.push(normalizeMsbuildPath(match[1]));
    }
  }
  return uniqueStrings(values);
}

function normalizeMsbuildPath(path: string): string {
  return normalize(path.replace(/\\/gu, "/"));
}

function stripXmlComments(source: string): string {
  let output = "";
  let index = 0;
  while (index < source.length) {
    const start = source.indexOf("<!--", index);
    if (start === -1) {
      output += source.slice(index);
      break;
    }
    output += source.slice(index, start);
    const end = source.indexOf("-->", start + 4);
    if (end === -1) {
      break;
    }
    index = end + 3;
  }
  return output;
}

function isStrongTestProject(source: string): boolean {
  return (
    /<IsTestProject>\s*true\s*<\/IsTestProject>/iu.test(source) ||
    /<Project\b[^>]*\bSdk\s*=\s*["']MSTest\.Sdk(?:\/|["'])/iu.test(source) ||
    /<Sdk\b[^>]*\bName\s*=\s*["']MSTest\.Sdk["']/iu.test(source) ||
    dotnetTestPackageReferencePattern.test(source)
  );
}

const dotnetTestPackageReferencePattern =
  /<PackageReference\b[^>]*\bInclude\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit|xunit\.v3|NUnit|NUnit3TestAdapter|MSTest\.TestFramework|Microsoft\.Testing\.Platform\.MSBuild|TUnit)["']/iu;

function isWebProject(
  source: string,
  packageReferences: string[],
  frameworkReferences: string[],
): boolean {
  return (
    /Microsoft\.NET\.Sdk\.Web/iu.test(source) ||
    frameworkReferences.includes("Microsoft.AspNetCore.App") ||
    packageReferences.some((name) => name.startsWith("Microsoft.AspNetCore.")) ||
    /\bMap(?:Get|Post|Put|Patch|Delete|Controllers|RazorPages|GrpcService)\s*\(/u.test(source)
  );
}

function isWorkerProject(source: string, packageReferences: string[]): boolean {
  return (
    /Microsoft\.NET\.Sdk\.Worker/iu.test(source) ||
    packageReferences.some((name) => name.startsWith("Microsoft.Extensions.Hosting")) ||
    /BackgroundService|IHostedService/u.test(source)
  );
}

function hasDatabaseEvidence(path: string, source: string): boolean {
  return /EntityFramework|Dapper|SqlClient|Npgsql|MySql|MongoDB|Cosmos|database|dbcontext/iu.test(
    `${path}\n${source}`,
  );
}

function isDotnetProjectPath(path: string): boolean {
  return /\.(?:cs|fs|vb)proj$/iu.test(path);
}

function isDotnetSolutionPath(path: string): boolean {
  return /\.(?:sln|slnx)$/iu.test(path);
}

function isDotnetSlnxPath(path: string): boolean {
  return /\.slnx$/iu.test(path);
}

function isDotnetConfigPath(path: string): boolean {
  return /(^|\/)(global\.json|Directory\.(?:Build|Packages)\.(?:props|targets)|\.editorconfig)$/u.test(
    path,
  );
}

function isDotnetSourcePath(path: string): boolean {
  return /\.(?:cs|fs|fsi|vb)$/iu.test(path);
}

function isProjectLanguageSourcePath(path: string, language: DotnetProject["language"]): boolean {
  const lower = path.toLowerCase();
  if (language === "fsharp") {
    return lower.endsWith(".fs") || lower.endsWith(".fsi");
  }
  if (language === "visual-basic") {
    return lower.endsWith(".vb");
  }
  return lower.endsWith(".cs");
}

function isGeneratedDotnetSourcePath(path: string): boolean {
  const base = basename(path);
  return (
    /(^|\/)(bin|obj|TestResults|Generated|generated)(\/|$)/u.test(path) ||
    /\.g(?:\.i)?\.cs$/u.test(base) ||
    base.endsWith(".AssemblyInfo.cs") ||
    base === "GlobalUsings.g.cs" ||
    base.startsWith("TemporaryGeneratedFile_")
  );
}

function isAspNetConventionPath(path: string): boolean {
  return isAspNetRouteConventionPath(path) || /(^|\/)Program\.cs$/iu.test(path);
}

function isAspNetRouteConventionPath(path: string): boolean {
  return /(^|\/)(Controllers?|Endpoints?|Pages)(\/|$)/iu.test(path);
}

function isLikelyTestProjectPath(path: string): boolean {
  const name = basename(path, extname(path));
  return (
    /(^|[._-])(?:tests?|specs?)(?:$|[._-])/iu.test(name) ||
    /(^|\/)(tests?|specs?)(\/|$)/iu.test(path)
  );
}

function projectRoot(path: string): string {
  const dir = dirname(path);
  return dir === "." ? "." : normalize(dir);
}

function projectLanguage(path: string): DotnetProject["language"] {
  const lower = path.toLowerCase();
  if (lower.endsWith(".fsproj")) {
    return "fsharp";
  }
  if (lower.endsWith(".vbproj")) {
    return "visual-basic";
  }
  return "csharp";
}

function dotnetLanguageName(language: DotnetProject["language"]): string {
  if (language === "fsharp") {
    return "F#";
  }
  if (language === "visual-basic") {
    return "Visual Basic";
  }
  return "C#";
}

function shouldSkipDotnetPath(path: string): boolean {
  if (shouldSkip(path) || isSampleProjectPath(path)) {
    return true;
  }
  return isDotnetGeneratedOrCachePath(path);
}

function isDotnetGeneratedOrCachePath(path: string): boolean {
  return (
    /(^|\/)(bin|obj|TestResults|\.vs)(\/|$)/u.test(path) ||
    /(^|\/)\.nuget\/(?:packages|fallbackpackages)(\/|$)/iu.test(path)
  );
}

function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function uniqueFileRefs(refs: SeedFileRef[]): SeedFileRef[] {
  const seen = new Set<string>();
  const output: SeedFileRef[] = [];
  for (const ref of refs) {
    if (seen.has(ref.path)) {
      continue;
    }
    seen.add(ref.path);
    output.push(ref);
  }
  return output;
}

function uniqueStrings<T extends string>(values: T[]): T[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}
