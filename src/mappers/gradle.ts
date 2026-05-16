import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed, SeedTestRef } from "./types.js";

const maxOwnedFiles = 12;
const maxTests = 8;
const jvmRoleDefinitions = {
  "web-entrypoint": {
    title: "web entrypoint",
    kind: "route",
    tags: ["jvm", "web"],
    trustBoundaries: ["network", "user-input", "serialization"],
  },
  "application-service": {
    title: "application service",
    kind: "service",
    tags: ["jvm", "service"],
    trustBoundaries: [],
  },
  "persistence-boundary": {
    title: "persistence boundary",
    kind: "service",
    tags: ["jvm", "persistence"],
    trustBoundaries: ["database", "serialization"],
  },
  "external-client": {
    title: "external client",
    kind: "service",
    tags: ["jvm", "external-api"],
    trustBoundaries: ["network", "external-api", "serialization"],
  },
  configuration: {
    title: "configuration",
    kind: "config",
    tags: ["jvm", "config"],
    trustBoundaries: ["filesystem"],
  },
  "framework-component": {
    title: "framework component",
    kind: "library",
    tags: ["jvm", "framework"],
    trustBoundaries: [],
  },
  "extension-boundary": {
    title: "extension boundary",
    kind: "library",
    tags: ["jvm", "interface"],
    trustBoundaries: [],
  },
} as const satisfies Record<
  string,
  {
    title: string;
    kind: FeatureSeed["kind"];
    tags: string[];
    trustBoundaries: FeatureSeed["trustBoundaries"];
  }
>;
type JvmRoleKey = keyof typeof jvmRoleDefinitions;
type JvmRoleEvidence = {
  role: JvmRoleKey;
  reason: string;
};
type JavaDeclaration = {
  kind: "class" | "interface" | "record" | "enum";
  name: string;
  extendsTypes: string[];
  implementsTypes: string[];
};
type JavaFileInfo = {
  packageName: string | null;
  annotations: Set<string>;
  imports: Map<string, string>;
  declarations: JavaDeclaration[];
  methodReturnTypes: Set<string>;
};

export async function gradleSeeds(root: string): Promise<FeatureSeed[]> {
  const roots = await discoverGradleRoots(root);
  const seeds: FeatureSeed[] = [];
  for (const gradleRoot of roots) {
    seeds.push(...(await gradleProjectSeeds(root, gradleRoot)));
  }
  return seeds;
}

async function gradleProjectSeeds(root: string, gradleRoot: string): Promise<FeatureSeed[]> {
  const moduleRoots = await gradleModuleRoots(root, gradleRoot);
  const seeds: FeatureSeed[] = [];
  for (const moduleRoot of moduleRoots) {
    const buildFile = await gradleBuildFile(root, moduleRoot);
    if (buildFile === null) {
      continue;
    }
    const sourceRoot = moduleRoot === "." ? "src" : `${moduleRoot}/src`;
    const sourceFiles = (await walk(root, [sourceRoot]))
      .filter(isGradleSourceFile)
      .filter((file) => !isGradleTestFile(moduleRoot, file));
    const testFiles = (await walk(root, [sourceRoot]))
      .filter(isGradleSourceFile)
      .filter((file) => isGradleTestFile(moduleRoot, file));
    const tags = gradleTags(buildFile, sourceFiles);

    seeds.push({
      title: `Gradle module ${moduleRoot}`,
      summary: `Gradle module rooted at ${moduleRoot}.`,
      kind: tags.includes("android") ? "ui-flow" : "library",
      source: "gradle-module",
      confidence: "medium",
      entryPath: buildFile,
      symbol: moduleRoot,
      route: null,
      command: null,
      ownedFiles: [{ path: buildFile, reason: "gradle build file" }],
      contextFiles: await gradleContextFiles(root, moduleRoot),
      tags,
      trustBoundaries: ["filesystem", "process-exec"],
      skipNearbyTests: true,
    });

    for (const group of partitionFileGroups(sourceRoot, sourceFiles, maxOwnedFiles)) {
      const tests = associatedGradleTests(group.files, testFiles);
      seeds.push({
        title: `Gradle source ${group.label}`,
        summary: `Gradle source group ${group.label} with ${group.files.length} files.`,
        kind: tags.includes("android") ? "ui-flow" : "library",
        source: "gradle-source-group",
        confidence: "medium",
        entryPath: buildFile,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `gradle source group ${group.label}`,
        })),
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated gradle test" })),
        tests,
        tags,
        trustBoundaries: ["filesystem", "process-exec"],
        skipNearbyTests: true,
      });
    }

    seeds.push(...(await jvmRoleSeeds(root, buildFile, sourceRoot, sourceFiles, testFiles, tags)));

    if (testFiles.length > 0) {
      for (const group of partitionFileGroups(sourceRoot, testFiles, maxOwnedFiles)) {
        seeds.push({
          title: `Gradle test suite ${group.label}`,
          summary: `Gradle test group ${group.label} with ${group.files.length} files.`,
          kind: "test-suite",
          source: "gradle-test-group",
          confidence: "medium",
          entryPath: group.files[0] ?? buildFile,
          symbol: group.label,
          route: null,
          command: null,
          ownedFiles: group.files.map((path) => ({
            path,
            reason: `gradle test group ${group.label}`,
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

async function jvmRoleSeeds(
  root: string,
  buildFile: string,
  sourceRoot: string,
  sourceFiles: string[],
  testFiles: string[],
  tags: string[],
): Promise<FeatureSeed[]> {
  const matches = new Map<JvmRoleKey, Map<string, string[]>>();
  const javaFiles: Array<{ filePath: string; info: JavaFileInfo }> = [];
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".java"))) {
    const source = await readFile(join(root, filePath), "utf8");
    javaFiles.push({ filePath, info: parseJavaFile(source) });
  }
  const projectPackages = new Set(
    javaFiles.flatMap(({ info }) => (info.packageName === null ? [] : [info.packageName])),
  );

  for (const { filePath, info } of javaFiles) {
    for (const evidence of jvmRoleEvidence(info, projectPackages)) {
      const byFile = matches.get(evidence.role) ?? new Map<string, string[]>();
      const reasons = byFile.get(filePath) ?? [];
      reasons.push(evidence.reason);
      byFile.set(filePath, reasons);
      matches.set(evidence.role, byFile);
    }
  }

  const seeds: FeatureSeed[] = [];
  for (const [role, byFile] of [...matches.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const definition = jvmRoleDefinitions[role];
    for (const group of partitionFileGroups(sourceRoot, [...byFile.keys()], maxOwnedFiles)) {
      const tests = associatedGradleTests(group.files, testFiles);
      seeds.push({
        title: `JVM role ${definition.title} ${group.label}`,
        summary: `JVM ${definition.title} group ${group.label} with ${group.files.length} files, classified from Java code evidence.`,
        kind: definition.kind,
        source: `jvm-role-${role}`,
        confidence: role === "extension-boundary" ? "medium" : "high",
        entryPath: buildFile,
        symbol: group.label,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `jvm ${definition.title} evidence: ${unique(byFile.get(path) ?? []).join("; ")}`,
        })),
        contextFiles: tests.map((test) => ({ path: test.path, reason: "associated gradle test" })),
        tests,
        tags: [...tags, ...definition.tags],
        trustBoundaries: definition.trustBoundaries,
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

function jvmRoleEvidence(info: JavaFileInfo, projectPackages: Set<string>): JvmRoleEvidence[] {
  const evidence: JvmRoleEvidence[] = [];
  evidence.push(...annotationEvidence(info));
  evidence.push(...importEvidence(info));
  evidence.push(...declarationEvidence(info, projectPackages));
  evidence.push(...methodReturnEvidence(info, projectPackages));
  return dedupeEvidence(evidence);
}

function parseJavaFile(source: string): JavaFileInfo {
  const stripped = stripJavaComments(source);
  const packageName = /^\s*package\s+([A-Za-z0-9_.]+)\s*;/mu.exec(stripped)?.[1] ?? null;
  const imports = new Map<string, string>();
  for (const match of stripped.matchAll(/^\s*import\s+(?:static\s+)?([A-Za-z0-9_.]+)\s*;/gmu)) {
    const full = match[1];
    const simple = full?.split(".").at(-1);
    if (full !== undefined && simple !== undefined) {
      imports.set(simple, full);
    }
  }

  const annotations = new Set<string>();
  for (const match of stripped.matchAll(/@([A-Za-z_][A-Za-z0-9_.]*)/gu)) {
    const raw = match[1];
    if (raw !== undefined) {
      annotations.add(raw.split(".").at(-1) ?? raw);
    }
  }

  const methodReturnTypes = new Set<string>();
  for (const match of stripped.matchAll(
    /\b(?:public|protected|private|static|final|abstract|synchronized|native|default|\s)+([A-Z][A-Za-z0-9_$.<>?]*)\s+[A-Za-z_][A-Za-z0-9_]*\s*\(/gu,
  )) {
    const type = match[1];
    if (type !== undefined) {
      methodReturnTypes.add(baseJavaTypeName(stripGenericParameters(type)));
    }
  }

  return {
    packageName,
    annotations,
    imports,
    declarations: parseJavaDeclarations(stripped),
    methodReturnTypes,
  };
}

function parseJavaDeclarations(source: string): JavaDeclaration[] {
  const declarations: JavaDeclaration[] = [];
  const declarationPattern =
    /\b(class|interface|record|enum)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^{};]*>)?(?:\s*\([^{};]*\))?(?:\s+extends\s+([^{]+?))?(?:\s+implements\s+([^{]+?))?\s*\{/gsu;
  for (const match of source.matchAll(declarationPattern)) {
    const kind = match[1];
    const name = match[2];
    if (kind === undefined || name === undefined) {
      continue;
    }
    declarations.push({
      kind: kind as JavaDeclaration["kind"],
      name,
      extendsTypes: match[3] === undefined ? [] : javaTypeNames(match[3]),
      implementsTypes: match[4] === undefined ? [] : javaTypeNames(match[4]),
    });
  }
  return declarations;
}

function annotationEvidence(info: JavaFileInfo): JvmRoleEvidence[] {
  const evidence: JvmRoleEvidence[] = [];
  for (const annotation of info.annotations) {
    if (
      [
        "Controller",
        "RestController",
        "RequestMapping",
        "Path",
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "PATCH",
      ].includes(annotation)
    ) {
      evidence.push({ role: "web-entrypoint", reason: `annotation @${annotation}` });
    }
    if (["Service", "Component", "ApplicationScoped", "Singleton", "Named"].includes(annotation)) {
      evidence.push({ role: "application-service", reason: `annotation @${annotation}` });
    }
    if (["Entity", "Repository", "Table", "MappedSuperclass"].includes(annotation)) {
      evidence.push({ role: "persistence-boundary", reason: `annotation @${annotation}` });
    }
    if (["Configuration", "Bean", "ConfigurationProperties"].includes(annotation)) {
      evidence.push({ role: "configuration", reason: `annotation @${annotation}` });
    }
  }
  return evidence;
}

function importEvidence(info: JavaFileInfo): JvmRoleEvidence[] {
  const evidence: JvmRoleEvidence[] = [];
  for (const full of info.imports.values()) {
    if (
      full.startsWith("org.springframework.web.bind.annotation.") ||
      /^(?:jakarta|javax)\.ws\.rs\./u.test(full)
    ) {
      evidence.push({ role: "web-entrypoint", reason: `web framework import ${full}` });
    }
    if (
      /^(?:jakarta|javax)\.persistence\./u.test(full) ||
      full.startsWith("org.hibernate.") ||
      full.startsWith("java.sql.")
    ) {
      evidence.push({ role: "persistence-boundary", reason: `persistence import ${full}` });
    }
    if (
      isNetworkClientImport(full) ||
      full.startsWith("okhttp3.") ||
      full.startsWith("retrofit2.") ||
      full.startsWith("org.apache.http.") ||
      full.startsWith("io.grpc.") ||
      full.startsWith("software.amazon.awssdk.") ||
      full.startsWith("com.google.cloud.") ||
      full.startsWith("com.azure.")
    ) {
      evidence.push({ role: "external-client", reason: `external client import ${full}` });
    }
  }
  return evidence;
}

function declarationEvidence(info: JavaFileInfo, projectPackages: Set<string>): JvmRoleEvidence[] {
  const evidence: JvmRoleEvidence[] = [];
  for (const declaration of info.declarations) {
    if (declaration.kind === "interface") {
      evidence.push({
        role: "extension-boundary",
        reason: `interface declaration ${declaration.name}`,
      });
    }
    for (const type of [...declaration.extendsTypes, ...declaration.implementsTypes]) {
      const full = info.imports.get(type);
      if (full !== undefined && isExternalProjectImport(full, projectPackages)) {
        evidence.push({ role: "framework-component", reason: `inherits external type ${full}` });
      }
      if (declaration.implementsTypes.includes(type)) {
        evidence.push({ role: "extension-boundary", reason: `implements ${type}` });
      }
    }
  }
  return evidence;
}

function methodReturnEvidence(info: JavaFileInfo, projectPackages: Set<string>): JvmRoleEvidence[] {
  const evidence: JvmRoleEvidence[] = [];
  for (const type of info.methodReturnTypes) {
    const full = info.imports.get(type);
    if (full !== undefined && isExternalProjectImport(full, projectPackages)) {
      evidence.push({ role: "framework-component", reason: `returns external type ${full}` });
    }
  }
  return evidence;
}

function isExternalProjectImport(full: string, projectPackages: Set<string>): boolean {
  if (/^(?:java|javax|jakarta)\./u.test(full)) {
    return false;
  }
  for (const packageName of projectPackages) {
    if (full.startsWith(`${packageName}.`)) {
      return false;
    }
  }
  return true;
}

function isNetworkClientImport(full: string): boolean {
  return (
    full.startsWith("java.net.http.") ||
    [
      "java.net.DatagramSocket",
      "java.net.HttpURLConnection",
      "java.net.ServerSocket",
      "java.net.Socket",
      "java.net.URL",
      "java.net.URLConnection",
    ].includes(full)
  );
}

function javaTypeNames(raw: string): string[] {
  return splitJavaTypeList(raw)
    .map((type) => baseJavaTypeName(stripGenericParameters(type)))
    .filter((type) => type.length > 0);
}

function baseJavaTypeName(raw: string): string {
  return (
    raw
      .replace(/\?.*$/su, "")
      .split(".")
      .at(-1)
      ?.replace(/[^A-Za-z0-9_$]/gu, "")
      .trim() ?? ""
  );
}

function splitJavaTypeList(raw: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of raw) {
    if (char === "<") {
      depth += 1;
    } else if (char === ">") {
      depth = Math.max(0, depth - 1);
    }
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function stripGenericParameters(raw: string): string {
  let depth = 0;
  let result = "";
  for (const char of raw) {
    if (char === "<") {
      depth += 1;
      continue;
    }
    if (char === ">") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) {
      result += char;
    }
  }
  return result;
}

function stripJavaComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, (value) => " ".repeat(value.length))
    .replace(/\/\/.*$/gmu, "");
}

function dedupeEvidence(evidence: JvmRoleEvidence[]): JvmRoleEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.role}:${item.reason}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function discoverGradleRoots(root: string): Promise<string[]> {
  const roots: string[] = [];
  await discoverGradleRootsInto(root, ".", 5, roots);
  return roots.toSorted();
}

async function discoverGradleRootsInto(
  root: string,
  dir: string,
  remainingDepth: number,
  roots: string[],
): Promise<void> {
  if (remainingDepth < 0 || (dir !== "." && (shouldSkip(dir) || isSampleProjectPath(dir)))) {
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
  const hasSettings =
    (await pathExists(join(full, "settings.gradle"))) ||
    (await pathExists(join(full, "settings.gradle.kts")));
  if (hasSettings || (await gradleBuildFile(root, dir)) !== null) {
    roots.push(dir);
  }
  if (hasSettings) {
    return;
  }
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child)) {
      continue;
    }
    const childInfo = await lstat(join(full, entry));
    if (childInfo.isDirectory() && !childInfo.isSymbolicLink()) {
      await discoverGradleRootsInto(root, child, remainingDepth - 1, roots);
    }
  }
}

async function gradleModuleRoots(root: string, gradleRoot: string): Promise<string[]> {
  const modules = new Set<string>([gradleRoot]);
  await collectGradleModules(root, gradleRoot, 3, modules);
  return [...modules].toSorted();
}

async function collectGradleModules(
  root: string,
  dir: string,
  remainingDepth: number,
  modules: Set<string>,
): Promise<void> {
  if (remainingDepth < 0 || shouldSkip(dir) || isSampleProjectPath(dir)) {
    return;
  }
  const full = dir === "." ? root : join(root, dir);
  for (const entry of await readdir(full)) {
    const child = dir === "." ? entry : `${dir}/${entry}`;
    if (shouldSkip(child) || isSampleProjectPath(child)) {
      continue;
    }
    const childFull = join(full, entry);
    const childInfo = await lstat(childFull);
    if (!childInfo.isDirectory() || childInfo.isSymbolicLink()) {
      continue;
    }
    if ((await gradleBuildFile(root, child)) !== null) {
      modules.add(child);
    }
    await collectGradleModules(root, child, remainingDepth - 1, modules);
  }
}

async function gradleBuildFile(root: string, moduleRoot: string): Promise<string | null> {
  for (const file of ["build.gradle.kts", "build.gradle"]) {
    const path = moduleRoot === "." ? file : `${moduleRoot}/${file}`;
    if (await pathExists(join(root, path))) {
      return path;
    }
  }
  return null;
}

async function gradleContextFiles(
  root: string,
  moduleRoot: string,
): Promise<Array<{ path: string; reason: string }>> {
  const candidates = ["AGENTS.md", "README.md", "src/main/AndroidManifest.xml"].map((file) =>
    moduleRoot === "." ? file : `${moduleRoot}/${file}`,
  );
  const refs: Array<{ path: string; reason: string }> = [];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      refs.push({ path: candidate, reason: "gradle module context" });
    }
  }
  return refs;
}

function associatedGradleTests(files: string[], testFiles: string[]): SeedTestRef[] {
  const stems = new Set(files.map((file) => basename(file).replace(/\.[^.]+$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return testFiles
    .filter((test) => {
      const stem = basename(test)
        .replace(/\.[^.]+$/u, "")
        .replace(/(?:Test|Spec)$/u, "");
      return stems.has(stem) || [...dirs].some((dir) => pathMatchesPrefix(test, dir));
    })
    .slice(0, maxTests)
    .map((path) => ({ path, command: null }));
}

function gradleTags(buildFile: string, sourceFiles: string[]): string[] {
  const tags = ["gradle"];
  if (
    buildFile.endsWith(".kts") ||
    sourceFiles.some((file) => file.endsWith(".kt") || file.endsWith(".kts"))
  ) {
    tags.push("kotlin");
  }
  if (
    sourceFiles.some((file) => file.endsWith("AndroidManifest.xml")) ||
    buildFile.includes("android")
  ) {
    tags.push("android");
  }
  return tags;
}

function isGradleSourceFile(path: string): boolean {
  const normalized = normalize(path);
  return (
    /\.(kt|kts|java|xml)$/u.test(normalized) &&
    /(^|\/)src\//u.test(normalized) &&
    !/(^|\/)(build|generated|intermediates)(\/|$)/u.test(normalized)
  );
}

function isGradleTestFile(moduleRoot: string, path: string): boolean {
  const relativePath = normalize(path).slice(moduleRoot === "." ? 0 : moduleRoot.length + 1);
  return (
    pathMatchesPrefix(relativePath, "src/test") ||
    pathMatchesPrefix(relativePath, "src/androidTest")
  );
}
