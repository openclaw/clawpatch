import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import { associatedJvmTests, jvmRoleSeeds } from "./jvm.js";
import { isSampleProjectPath, normalize, shouldSkip, walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

const maxOwnedFiles = 12;

type MavenProjectInfo = {
  root: string;
  pomPath: string;
  artifactId: string;
  packaging: string | null;
  modules: string[];
  hasSpring: boolean;
  hasSpringBoot: boolean;
};

export async function mavenSeeds(root: string): Promise<FeatureSeed[]> {
  const roots = await discoverMavenRoots(root);
  const seeds: FeatureSeed[] = [];
  const mappedModuleRoots = new Set<string>();
  for (const mavenRoot of roots) {
    seeds.push(...(await mavenProjectSeeds(root, mavenRoot, mappedModuleRoots)));
  }
  return seeds;
}

async function mavenProjectSeeds(
  root: string,
  mavenRoot: string,
  mappedModuleRoots: Set<string>,
): Promise<FeatureSeed[]> {
  const moduleRoots = await mavenModuleRoots(root, mavenRoot);
  const seeds: FeatureSeed[] = [];
  for (const moduleRoot of moduleRoots) {
    if (mappedModuleRoots.has(moduleRoot)) {
      continue;
    }
    const info = await readMavenProject(root, moduleRoot);
    if (info === null) {
      continue;
    }
    mappedModuleRoots.add(moduleRoot);
    const sourceRoot = moduleRoot === "." ? "src" : `${moduleRoot}/src`;
    const sourceFiles = (await walk(root, [sourceRoot]))
      .filter(isMavenSourceFile)
      .filter((file) => !isMavenTestFile(moduleRoot, file));
    const testFiles = (await walk(root, [sourceRoot]))
      .filter(isMavenSourceFile)
      .filter((file) => isMavenTestFile(moduleRoot, file));
    const tags = mavenTags(info, sourceFiles);
    const contextFiles = await mavenContextFiles(root, moduleRoot);

    seeds.push({
      title: `Maven module ${info.artifactId}`,
      summary: `Maven module ${info.artifactId} rooted at ${moduleRoot}.`,
      kind: "library",
      source: "maven-module",
      confidence: "medium",
      entryPath: info.pomPath,
      symbol: info.artifactId,
      route: null,
      command: null,
      ownedFiles: [{ path: info.pomPath, reason: "maven project file" }],
      contextFiles,
      tags,
      trustBoundaries: ["filesystem", "process-exec"],
      skipNearbyTests: true,
    });

    for (const group of partitionFileGroups(sourceRoot, sourceFiles, maxOwnedFiles)) {
      const tests = associatedJvmTests(group.files, testFiles);
      seeds.push({
        title: `Maven source ${group.label}`,
        summary: `Maven source group ${group.label} with ${group.files.length} files.`,
        kind: "library",
        source: "maven-source-group",
        confidence: "medium",
        entryPath: info.pomPath,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `maven source group ${group.label}`,
        })),
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated maven test" })),
        tests,
        tags,
        trustBoundaries: ["filesystem", "process-exec"],
        skipNearbyTests: true,
      });
    }

    seeds.push(
      ...(await jvmRoleSeeds(root, info.pomPath, sourceRoot, sourceFiles, testFiles, tags)),
    );

    if (testFiles.length > 0) {
      for (const group of partitionFileGroups(sourceRoot, testFiles, maxOwnedFiles)) {
        seeds.push({
          title: `Maven test suite ${group.label}`,
          summary: `Maven test group ${group.label} with ${group.files.length} files.`,
          kind: "test-suite",
          source: "maven-test-group",
          confidence: "medium",
          entryPath: group.files[0] ?? info.pomPath,
          symbol: group.label,
          route: null,
          command: null,
          ownedFiles: group.files.map((path) => ({
            path,
            reason: `maven test group ${group.label}`,
          })),
          tags: [...tags, "test"],
          trustBoundaries: [],
          skipNearbyTests: true,
        });
      }
    }
  }
  return seeds;
}

async function discoverMavenRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await discoverMavenRootsInto(root, ".", 5, roots);
  return roots.toSorted();
}

async function discoverMavenRootsInto(
  root: string,
  dir: string,
  remainingDepth: number,
  roots: string[],
): Promise<void> {
  if (remainingDepth < 0 || (dir !== "." && shouldSkipMavenPath(dir))) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  if (!(await pathExists(full))) {
    return;
  }
  const info = await lstat(full);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    return;
  }
  if ((await mavenPomFile(root, dir)) !== null) {
    roots.push(dir);
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkipMavenPath(child)) {
      continue;
    }
    const childInfo = await lstat(join(full, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await discoverMavenRootsInto(root, child, remainingDepth - 1, roots);
    }
  }
}

async function mavenModuleRoots(root: string, mavenRoot: string): Promise<string[]> {
  const modules = new Set<string>([mavenRoot]);
  await collectMavenModules(root, mavenRoot, 5, modules);
  return [...modules].toSorted();
}

async function collectMavenModules(
  root: string,
  moduleRoot: string,
  remainingDepth: number,
  modules: Set<string>,
): Promise<void> {
  if (remainingDepth < 0 || shouldSkipMavenPath(moduleRoot)) {
    return;
  }
  const info = await readMavenProject(root, moduleRoot);
  if (info === null) {
    return;
  }
  for (const modulePath of info.modules) {
    const childRoot = mavenModulePath(moduleRoot, modulePath);
    if (childRoot === null || shouldSkipMavenPath(childRoot)) {
      continue;
    }
    if ((await mavenPomFile(root, childRoot)) === null) {
      continue;
    }
    modules.add(childRoot);
    await collectMavenModules(root, childRoot, remainingDepth - 1, modules);
  }
}

async function readMavenProject(
  root: string,
  moduleRoot: string,
): Promise<MavenProjectInfo | null> {
  const pomPath = await mavenPomFile(root, moduleRoot);
  if (pomPath === null) {
    return null;
  }
  const source = await readFile(join(root, pomPath), "utf8").catch(() => "");
  const activeSource = stripXmlComments(source);
  const topLevel = removeXmlBlocks(activeSource, [
    "parent",
    "modules",
    "dependencies",
    "dependencyManagement",
    "build",
    "profiles",
    "repositories",
    "pluginRepositories",
    "reporting",
  ]);
  return {
    root: moduleRoot,
    pomPath,
    artifactId: xmlElementValue(topLevel, "artifactId") ?? mavenFallbackArtifactId(moduleRoot),
    packaging: xmlElementValue(topLevel, "packaging"),
    modules: xmlElementValuesInBlocks(activeSource, "modules", "module"),
    hasSpring: mavenPomHasSpring(activeSource),
    hasSpringBoot: mavenPomHasSpringBoot(activeSource),
  };
}

async function mavenPomFile(root: string, moduleRoot: string): Promise<string | null> {
  const path = moduleRoot === "." ? "pom.xml" : `${moduleRoot}/pom.xml`;
  return (await pathExists(join(root, path))) ? path : null;
}

async function mavenContextFiles(
  root: string,
  moduleRoot: string,
): Promise<Array<{ path: string; reason: string }>> {
  const candidates = ["AGENTS.md", "README.md", ".mvn/maven.config"].map((file) =>
    moduleRoot === "." ? file : `${moduleRoot}/${file}`,
  );
  const refs: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      refs.push({ path: candidate, reason: "maven module context" });
    }
  }
  for (const path of await mavenSpringResourceFiles(root, moduleRoot)) {
    refs.push({ path, reason: "spring application configuration" });
  }
  return refs;
}

async function mavenSpringResourceFiles(root: string, moduleRoot: string): Promise<string[]> {
  const resourcesRoot =
    moduleRoot === "." ? "src/main/resources" : `${moduleRoot}/src/main/resources`;
  return (await walk(root, [resourcesRoot])).filter((path) =>
    /(^|\/)application(?:[-.][^/]*)?\.(?:properties|ya?ml)$/iu.test(path),
  );
}

function mavenTags(info: MavenProjectInfo, sourceFiles: string[]): string[] {
  const tags = ["maven", `project:${info.artifactId}`, `project-root:${info.root}`];
  if (sourceFiles.some((file) => file.endsWith(".java"))) {
    tags.push("java");
  }
  if (sourceFiles.some((file) => file.endsWith(".kt") || file.endsWith(".kts"))) {
    tags.push("kotlin");
  }
  if (info.packaging !== null) {
    tags.push(`packaging:${info.packaging}`);
  }
  if (info.hasSpring) {
    tags.push("spring");
  }
  if (info.hasSpringBoot) {
    tags.push("spring-boot");
  }
  return tags;
}

function mavenModulePath(moduleRoot: string, modulePath: string): string | null {
  const normalizedModulePath = normalize(modulePath.trim().replace(/\\/gu, "/"));
  if (
    normalizedModulePath.length === 0 ||
    normalizedModulePath === "." ||
    /^(?:[A-Za-z]:)?\//u.test(normalizedModulePath)
  ) {
    return null;
  }
  const base = moduleRoot === "." ? "" : moduleRoot;
  const resolved = normalize(join(base, normalizedModulePath));
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    return null;
  }
  return resolved;
}

function mavenFallbackArtifactId(moduleRoot: string): string {
  return moduleRoot === "." ? "root" : basename(moduleRoot);
}

function shouldSkipMavenPath(path: string): boolean {
  return (
    shouldSkip(path) || isSampleProjectPath(path) || path === "vendor" || path.startsWith("vendor/")
  );
}

function mavenPomHasSpring(source: string): boolean {
  return (
    mavenPomHasSpringBoot(source) ||
    /<groupId>\s*org\.springframework(?:\.[^<]*)?\s*<\/groupId>/iu.test(source)
  );
}

function mavenPomHasSpringBoot(source: string): boolean {
  return (
    /<groupId>\s*org\.springframework\.boot\s*<\/groupId>/iu.test(source) ||
    /<artifactId>\s*spring-boot-[^<]*\s*<\/artifactId>/iu.test(source)
  );
}

function isMavenSourceFile(path: string): boolean {
  const normalized = normalize(path);
  return /\.(?:java|kt|kts)$/u.test(normalized);
}

function isMavenTestFile(moduleRoot: string, path: string): boolean {
  const relativePath = normalize(path).slice(moduleRoot === "." ? 0 : moduleRoot.length + 1);
  return /^src\/(?:test|it|integrationTest)\//u.test(relativePath);
}

function xmlElementValue(source: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`<${escapedName}\\b[^>]*>\\s*([^<]+?)\\s*</${escapedName}>`, "iu")
      .exec(source)?.[1]
      ?.trim() ?? null
  );
}

function xmlElementValuesInBlocks(
  source: string,
  blockName: string,
  elementName: string,
): string[] {
  const values: string[] = [];
  const escapedBlock = blockName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const escapedElement = elementName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const blockPattern = new RegExp(`<${escapedBlock}\\b[^>]*>([\\s\\S]*?)</${escapedBlock}>`, "giu");
  const elementPattern = new RegExp(
    `<${escapedElement}\\b[^>]*>\\s*([^<]+?)\\s*</${escapedElement}>`,
    "giu",
  );
  for (const block of source.matchAll(blockPattern)) {
    for (const match of (block[1] ?? "").matchAll(elementPattern)) {
      const value = match[1]?.trim();
      if (value !== undefined && value.length > 0) {
        values.push(value);
      }
    }
  }
  return [...new Set(values)];
}

function removeXmlBlocks(source: string, names: string[]): string {
  let output = source;
  for (const name of names) {
    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    output = output.replace(
      new RegExp(`<${escapedName}\\b[^>]*>[\\s\\S]*?</${escapedName}>`, "giu"),
      " ",
    );
  }
  return output;
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
