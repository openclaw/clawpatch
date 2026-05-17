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
const kotlinRoleDefinitions = {
  "android-ui-entrypoint": {
    title: "UI entrypoint",
    kind: "ui-flow",
    tags: ["kotlin", "android", "ui"],
    trustBoundaries: ["user-input", "serialization"],
  },
  "android-view-model": {
    title: "view model",
    kind: "service",
    tags: ["kotlin", "android", "view-model"],
    trustBoundaries: [],
  },
  "android-data-boundary": {
    title: "data boundary",
    kind: "service",
    tags: ["kotlin", "android", "data"],
    trustBoundaries: ["database", "serialization"],
  },
  "android-external-client": {
    title: "external client",
    kind: "service",
    tags: ["kotlin", "android", "network"],
    trustBoundaries: ["network", "external-api", "serialization"],
  },
  "android-dependency-injection": {
    title: "dependency injection",
    kind: "config",
    tags: ["kotlin", "android", "di"],
    trustBoundaries: ["serialization"],
  },
  "server-web-entrypoint": {
    title: "web entrypoint",
    kind: "route",
    tags: ["kotlin", "server", "web"],
    trustBoundaries: ["network", "user-input", "serialization"],
  },
  "server-application-service": {
    title: "application service",
    kind: "service",
    tags: ["kotlin", "server", "service"],
    trustBoundaries: [],
  },
  "server-persistence-boundary": {
    title: "persistence boundary",
    kind: "service",
    tags: ["kotlin", "server", "persistence"],
    trustBoundaries: ["database", "serialization"],
  },
  "server-external-client": {
    title: "external client",
    kind: "service",
    tags: ["kotlin", "server", "external-api"],
    trustBoundaries: ["network", "external-api", "serialization"],
  },
  "server-configuration": {
    title: "configuration",
    kind: "config",
    tags: ["kotlin", "server", "config"],
    trustBoundaries: ["filesystem"],
  },
  "server-framework-component": {
    title: "framework component",
    kind: "library",
    tags: ["kotlin", "server", "framework"],
    trustBoundaries: [],
  },
  "server-extension-boundary": {
    title: "extension boundary",
    kind: "library",
    tags: ["kotlin", "server", "interface"],
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
type KotlinRoleKey = keyof typeof kotlinRoleDefinitions;
type KotlinRoleEvidence = {
  role: KotlinRoleKey;
  reason: string;
  confidence: FeatureSeed["confidence"];
};
type KotlinDeclaration = {
  kind: "class" | "interface" | "object";
  name: string;
  supertypes: string[];
};
type KotlinFileInfo = {
  packageName: string | null;
  annotations: Set<string>;
  annotationImports: Map<string, string>;
  imports: Map<string, string>;
  declarations: KotlinDeclaration[];
  functionReturnTypes: Set<string>;
};
const kotlinServerWebAnnotationNames = new Set([
  "Controller",
  "RestController",
  "RequestMapping",
  "GetMapping",
  "PostMapping",
  "PutMapping",
  "DeleteMapping",
  "PatchMapping",
  "Path",
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
]);

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
    const tags = await gradleTags(root, buildFile, sourceFiles);

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
    seeds.push(
      ...(await kotlinRoleSeeds(root, buildFile, sourceRoot, sourceFiles, testFiles, tags)),
    );

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

async function kotlinRoleSeeds(
  root: string,
  buildFile: string,
  sourceRoot: string,
  sourceFiles: string[],
  testFiles: string[],
  tags: string[],
): Promise<FeatureSeed[]> {
  const matches = new Map<
    KotlinRoleKey,
    Map<string, Array<{ reason: string; confidence: FeatureSeed["confidence"] }>>
  >();
  const kotlinFiles: Array<{ filePath: string; info: KotlinFileInfo }> = [];
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".kt"))) {
    const source = await readFile(join(root, filePath), "utf8");
    kotlinFiles.push({ filePath, info: parseKotlinFile(source) });
  }
  if (kotlinFiles.length === 0) {
    return [];
  }
  const javaFiles: Array<{ filePath: string; info: JavaFileInfo }> = [];
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".java"))) {
    const source = await readFile(join(root, filePath), "utf8");
    javaFiles.push({ filePath, info: parseJavaFile(source) });
  }
  const projectPackages = new Set(
    [...kotlinFiles, ...javaFiles].flatMap(({ info }) =>
      info.packageName === null ? [] : [info.packageName],
    ),
  );
  const projectTypes = new Set([
    ...kotlinFiles.flatMap(({ info }) => info.declarations.map((declaration) => declaration.name)),
    ...javaFiles.flatMap(({ info }) => info.declarations.map((declaration) => declaration.name)),
  ]);
  const projectPackageTypes = new Set(
    [...kotlinFiles, ...javaFiles].flatMap(({ info }) =>
      info.packageName === null
        ? []
        : info.declarations.map((declaration) => `${info.packageName}.${declaration.name}`),
    ),
  );

  for (const { filePath, info } of kotlinFiles) {
    const frameworkEvidence = kotlinFrameworkRoleEvidence(
      info,
      tags,
      projectPackages,
      projectTypes,
      projectPackageTypes,
    );
    const evidence = kotlinEvidenceWithPathFallback(
      frameworkEvidence,
      kotlinPathRoleEvidence(filePath, tags),
    );
    for (const item of evidence) {
      const byFile = matches.get(item.role) ?? new Map();
      const reasons = byFile.get(filePath) ?? [];
      reasons.push({ reason: item.reason, confidence: item.confidence });
      byFile.set(filePath, reasons);
      matches.set(item.role, byFile);
    }
  }

  const seeds: FeatureSeed[] = [];
  for (const [role, byFile] of [...matches.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const definition = kotlinRoleDefinitions[role];
    const platform = role.startsWith("android-") ? "Android" : "server";
    const groups = kotlinRoleGroups(sourceRoot, byFile);
    for (const { confidence, group, label, symbol } of groups) {
      const tests = associatedGradleTests(group.files, testFiles);
      seeds.push({
        title: `Kotlin ${platform} role ${definition.title} ${label}`,
        summary: `Kotlin ${platform.toLowerCase()} ${definition.title} group ${label} with ${group.files.length} files, classified from Kotlin code evidence.`,
        kind: definition.kind,
        source: kotlinRoleSource(role),
        confidence,
        entryPath: buildFile,
        symbol,
        route: null,
        command: null,
        ownedFiles: group.files.map((path) => ({
          path,
          reason: `kotlin ${definition.title} evidence: ${unique(
            (byFile.get(path) ?? []).map((item) => item.reason),
          ).join("; ")}`,
        })),
        contextFiles: tests.map((test) => ({
          path: test.path,
          reason: "associated gradle test",
        })),
        tests,
        tags: [...tags, ...definition.tags],
        trustBoundaries: definition.trustBoundaries,
        skipNearbyTests: true,
      });
    }
  }
  return seeds;
}

function kotlinRoleGroups(
  sourceRoot: string,
  byFile: Map<string, Array<{ reason: string; confidence: FeatureSeed["confidence"] }>>,
): Array<{
  confidence: FeatureSeed["confidence"];
  group: { label: string; files: string[] };
  label: string;
  symbol: string;
}> {
  return partitionFileGroups(sourceRoot, [...byFile.keys()], maxOwnedFiles).map((group) => ({
    confidence: group.files.some((path) =>
      (byFile.get(path) ?? []).some((item) => item.confidence === "high"),
    )
      ? "high"
      : "medium",
    group,
    label: group.label,
    symbol: group.label,
  }));
}

function kotlinRoleSource(role: KotlinRoleKey): string {
  if (role.startsWith("android-")) {
    return `kotlin-android-role-${role.slice("android-".length)}`;
  }
  return `kotlin-server-role-${role.slice("server-".length)}`;
}

function kotlinEvidenceWithPathFallback(
  frameworkEvidence: KotlinRoleEvidence[],
  pathEvidence: KotlinRoleEvidence[],
): KotlinRoleEvidence[] {
  if (frameworkEvidence.every((item) => item.role === "server-extension-boundary")) {
    return dedupeKotlinEvidence([...frameworkEvidence, ...pathEvidence]);
  }
  if (frameworkEvidence.every((item) => item.role === "android-dependency-injection")) {
    return dedupeKotlinEvidence([
      ...frameworkEvidence,
      ...pathEvidence.filter((item) =>
        ["android-ui-entrypoint", "android-data-boundary", "android-external-client"].includes(
          item.role,
        ),
      ),
    ]);
  }
  return frameworkEvidence;
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

function kotlinFrameworkRoleEvidence(
  info: KotlinFileInfo,
  tags: string[],
  projectPackages: Set<string>,
  projectTypes: Set<string>,
  projectPackageTypes: Set<string>,
): KotlinRoleEvidence[] {
  const evidence: KotlinRoleEvidence[] = [];
  const isAndroid = tags.includes("android");
  for (const annotation of info.annotations) {
    if (isAndroid && ["Composable"].includes(annotation)) {
      evidence.push({
        role: "android-ui-entrypoint",
        reason: `annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (isAndroid && ["HiltViewModel"].includes(annotation)) {
      evidence.push({
        role: "android-view-model",
        reason: `annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (isAndroid && ["Entity", "Dao", "Database", "Embedded", "Relation"].includes(annotation)) {
      evidence.push({
        role: "android-data-boundary",
        reason: `Room annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (
      isAndroid &&
      [
        "AndroidEntryPoint",
        "HiltAndroidApp",
        "Module",
        "InstallIn",
        "Provides",
        "Binds",
        "Inject",
        "Singleton",
        "Component",
        "DependencyGraph",
        "BindingContainer",
        "ContributesBinding",
      ].includes(annotation)
    ) {
      evidence.push({
        role: "android-dependency-injection",
        reason: `dependency injection annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (!isAndroid && isKotlinServerWebAnnotation(annotation, info)) {
      evidence.push({
        role: "server-web-entrypoint",
        reason: `server web annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (
      !isAndroid &&
      ["Service", "Component", "ApplicationScoped", "Singleton", "Named"].includes(annotation)
    ) {
      evidence.push({
        role: "server-application-service",
        reason: `service annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (!isAndroid && ["Repository", "Table", "MappedSuperclass"].includes(annotation)) {
      evidence.push({
        role: "server-persistence-boundary",
        reason: `persistence annotation @${annotation}`,
        confidence: "high",
      });
    }
    if (!isAndroid && ["Configuration", "Bean", "ConfigurationProperties"].includes(annotation)) {
      evidence.push({
        role: "server-configuration",
        reason: `configuration annotation @${annotation}`,
        confidence: "high",
      });
    }
  }

  for (const full of info.imports.values()) {
    if (isAndroid && isAndroidEntrypointImport(full)) {
      evidence.push({
        role: "android-ui-entrypoint",
        reason: `Android entrypoint import ${full}`,
        confidence: "high",
      });
    }
    if (
      isAndroid &&
      (full === "androidx.lifecycle.ViewModel" || full === "androidx.lifecycle.AndroidViewModel")
    ) {
      evidence.push({
        role: "android-view-model",
        reason: `Android ViewModel import ${full}`,
        confidence: "high",
      });
    }
    if (isAndroid && full.startsWith("androidx.room.")) {
      evidence.push({
        role: "android-data-boundary",
        reason: `Room import ${full}`,
        confidence: "high",
      });
    }
    if (isKotlinExternalClientImport(full)) {
      evidence.push({
        role: isAndroid ? "android-external-client" : "server-external-client",
        reason: `external client import ${full}`,
        confidence: "high",
      });
    }
    if (
      isAndroid &&
      (full.startsWith("dagger.") ||
        full.startsWith("javax.inject.") ||
        full.startsWith("jakarta.inject.") ||
        full.startsWith("org.koin.") ||
        full.startsWith("me.tatarka.inject.") ||
        full.startsWith("dev.zacsweers.metro."))
    ) {
      const reason = full.startsWith("dev.zacsweers.metro.")
        ? `Metro import ${full}`
        : `dependency injection import ${full}`;
      evidence.push({
        role: "android-dependency-injection",
        reason,
        confidence: "high",
      });
    }
    if (!isAndroid && isKotlinServerWebImport(full)) {
      evidence.push({
        role: "server-web-entrypoint",
        reason: `server web import ${full}`,
        confidence: "high",
      });
    }
    if (
      !isAndroid &&
      (/^(?:jakarta|javax)\.persistence\./u.test(full) ||
        full.startsWith("org.hibernate.") ||
        full.startsWith("org.jetbrains.exposed.") ||
        full.startsWith("org.jooq.") ||
        isSpringDataPersistenceImport(full) ||
        full.startsWith("java.sql."))
    ) {
      evidence.push({
        role: "server-persistence-boundary",
        reason: `persistence import ${full}`,
        confidence: "high",
      });
    }
    if (
      !isAndroid &&
      (full.startsWith("org.springframework.context.annotation.") ||
        full.startsWith("org.springframework.boot.context.properties."))
    ) {
      evidence.push({
        role: "server-configuration",
        reason: `configuration import ${full}`,
        confidence: "high",
      });
    }
  }

  for (const declaration of info.declarations) {
    for (const type of declaration.supertypes) {
      if (
        isAndroid &&
        kotlinImportedTypeMatches(info, type, [
          "android.app.Activity",
          "android.app.Service",
          "android.content.BroadcastReceiver",
          "androidx.activity.ComponentActivity",
          "androidx.appcompat.app.AppCompatActivity",
          "androidx.fragment.app.Fragment",
        ])
      ) {
        evidence.push({
          role: "android-ui-entrypoint",
          reason: `inherits Android UI type ${type}`,
          confidence: "high",
        });
      }
      if (
        isAndroid &&
        kotlinImportedTypeMatches(info, type, [
          "androidx.lifecycle.ViewModel",
          "androidx.lifecycle.AndroidViewModel",
        ])
      ) {
        evidence.push({
          role: "android-view-model",
          reason: `inherits Android ViewModel type ${type}`,
          confidence: "high",
        });
      }
      if (isAndroid && kotlinImportedTypeMatches(info, type, ["androidx.room.RoomDatabase"])) {
        evidence.push({
          role: "android-data-boundary",
          reason: `inherits Room type ${type}`,
          confidence: "high",
        });
      }
    }
  }
  if (!isAndroid) {
    evidence.push(
      ...kotlinDeclarationRoleEvidence(info, projectPackages, projectTypes, projectPackageTypes),
    );
    evidence.push(
      ...kotlinFunctionReturnRoleEvidence(info, projectPackages, projectTypes, projectPackageTypes),
    );
  }

  return dedupeKotlinEvidence(evidence);
}

function isKotlinServerWebAnnotation(annotation: string, info: KotlinFileInfo): boolean {
  if (!kotlinServerWebAnnotationNames.has(annotation)) {
    return false;
  }
  const qualified = info.annotationImports.get(annotation);
  if (qualified !== undefined) {
    return isKotlinServerWebImport(qualified);
  }
  const imported = info.imports.get(annotation);
  if (imported !== undefined) {
    return isKotlinServerWebImport(imported);
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*") && isKotlinServerWebImport(full)) {
      return true;
    }
  }
  return false;
}

function isKotlinServerWebImport(full: string): boolean {
  return (
    full.startsWith("org.springframework.web.bind.annotation.") ||
    full.startsWith("io.ktor.server.") ||
    full.startsWith("org.http4k.") ||
    full.startsWith("io.javalin.") ||
    /^(?:jakarta|javax)\.ws\.rs\./u.test(full)
  );
}

function kotlinDeclarationRoleEvidence(
  info: KotlinFileInfo,
  projectPackages: Set<string>,
  projectTypes: Set<string>,
  projectPackageTypes: Set<string>,
): KotlinRoleEvidence[] {
  const evidence: KotlinRoleEvidence[] = [];
  for (const declaration of info.declarations) {
    if (declaration.kind === "interface") {
      evidence.push({
        role: "server-extension-boundary",
        reason: `interface declaration ${declaration.name}`,
        confidence: "medium",
      });
    }
    for (const type of declaration.supertypes) {
      const full = kotlinImportForType(
        info,
        type,
        projectTypes,
        projectPackages,
        projectPackageTypes,
      );
      if (full !== undefined && isExternalProjectImport(full, projectPackages)) {
        evidence.push({
          role: "server-framework-component",
          reason: `inherits external type ${full}`,
          confidence: "high",
        });
      }
    }
  }
  return evidence;
}

function kotlinImportedTypeMatches(info: KotlinFileInfo, type: string, allowed: string[]): boolean {
  if (allowed.includes(type)) {
    return true;
  }
  const direct = info.imports.get(type);
  if (direct !== undefined && allowed.includes(direct)) {
    return true;
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*") && allowed.includes(`${full.slice(0, -1)}${type}`)) {
      return true;
    }
  }
  return false;
}

function kotlinFunctionReturnRoleEvidence(
  info: KotlinFileInfo,
  projectPackages: Set<string>,
  projectTypes: Set<string>,
  projectPackageTypes: Set<string>,
): KotlinRoleEvidence[] {
  const evidence: KotlinRoleEvidence[] = [];
  for (const type of info.functionReturnTypes) {
    const full = kotlinImportForType(
      info,
      type,
      projectTypes,
      projectPackages,
      projectPackageTypes,
    );
    if (full !== undefined && isExternalProjectImport(full, projectPackages)) {
      evidence.push({
        role: "server-framework-component",
        reason: `returns external type ${full}`,
        confidence: "high",
      });
    }
  }
  return evidence;
}

function kotlinImportForType(
  info: KotlinFileInfo,
  type: string,
  projectTypes: Set<string>,
  projectPackages: Set<string>,
  projectPackageTypes: Set<string>,
): string | undefined {
  if (type.includes(".")) {
    const rootType = type.split(".")[0];
    if (rootType !== undefined && projectTypes.has(rootType)) {
      return undefined;
    }
    return type.startsWith("kotlin.") ? undefined : type;
  }
  if (info.declarations.some((declaration) => declaration.name === type)) {
    return undefined;
  }
  if (info.packageName !== null && projectPackageTypes.has(`${info.packageName}.${type}`)) {
    return undefined;
  }
  const direct = info.imports.get(type);
  if (direct !== undefined) {
    return direct.startsWith("kotlin.") ? undefined : direct;
  }
  if (isKotlinImplicitType(type)) {
    return undefined;
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*")) {
      if (full.startsWith("kotlin.")) {
        continue;
      }
      const candidate = `${full.slice(0, -1)}${type}`;
      if (isExternalProjectImport(candidate, projectPackages)) {
        return candidate;
      }
    }
  }
  if (projectTypes.has(type)) {
    return undefined;
  }
  return undefined;
}

function isKotlinImplicitType(type: string): boolean {
  return [
    "Any",
    "Array",
    "Boolean",
    "Byte",
    "Char",
    "CharSequence",
    "Collection",
    "Double",
    "Exception",
    "Float",
    "Int",
    "Iterable",
    "List",
    "Long",
    "Map",
    "MutableCollection",
    "MutableList",
    "MutableMap",
    "MutableSet",
    "Nothing",
    "Number",
    "Pair",
    "Result",
    "Sequence",
    "Set",
    "Short",
    "String",
    "Throwable",
    "Triple",
    "Unit",
  ].includes(type);
}

function kotlinPathRoleEvidence(filePath: string, tags: string[]): KotlinRoleEvidence[] {
  const normalized = normalize(filePath).toLowerCase();
  const isAndroid = tags.includes("android");
  const evidence: KotlinRoleEvidence[] = [];
  if (isAndroid && /(^|\/)ui(\/|$)/u.test(normalized)) {
    evidence.push({
      role: "android-ui-entrypoint",
      reason: "path segment ui",
      confidence: "medium",
    });
  }
  if (/(^|\/)(?:repository|data|database)(\/|$)/u.test(normalized)) {
    evidence.push({
      role: isAndroid ? "android-data-boundary" : "server-persistence-boundary",
      reason: "path segment data boundary",
      confidence: "medium",
    });
  }
  if (/(^|\/)network(\/|$)/u.test(normalized)) {
    evidence.push({
      role: isAndroid ? "android-external-client" : "server-external-client",
      reason: "path segment network",
      confidence: "medium",
    });
  }
  if (isAndroid && /(^|\/)di(\/|$)/u.test(normalized)) {
    evidence.push({
      role: "android-dependency-injection",
      reason: "path segment di",
      confidence: "medium",
    });
  }
  if (!isAndroid && /(^|\/)domain(\/|$)/u.test(normalized)) {
    evidence.push({
      role: "server-application-service",
      reason: "path segment domain",
      confidence: "medium",
    });
  }
  return evidence;
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

function parseKotlinFile(source: string): KotlinFileInfo {
  const stripped = stripKotlinComments(source);
  const packageName = /^\s*package\s+([A-Za-z0-9_.]+)\s*;?/mu.exec(stripped)?.[1] ?? null;
  const imports = new Map<string, string>();
  for (const match of stripped.matchAll(
    /^\s*import\s+([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\.\*)?(?:\s+as\s+([A-Za-z_][A-Za-z0-9_]*))?\s*;?/gmu,
  )) {
    const target = match[1];
    const wildcard = match[2];
    const alias = match[3];
    const full = target === undefined ? undefined : `${target}${wildcard ?? ""}`;
    const simple = alias ?? (wildcard === undefined ? target?.split(".").at(-1) : target);
    if (full !== undefined && simple !== undefined) {
      imports.set(simple, full);
    }
  }

  const annotations = new Set<string>();
  const annotationImports = new Map<string, string>();
  for (const match of stripped.matchAll(
    /@(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_.]*)/gu,
  )) {
    const raw = match[1];
    if (raw !== undefined) {
      const simple = raw.split(".").at(-1) ?? raw;
      annotations.add(simple);
      if (raw.includes(".")) {
        annotationImports.set(simple, raw);
      }
    }
  }

  const functionReturnTypes = new Set<string>();
  for (const match of stripped.matchAll(
    /\bfun\s*(?:<[^>{}\n]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.]*\s*\.\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\([^(){}]*\)\s*:\s*([^=\n{]+)/gu,
  )) {
    const type = match[1];
    if (type !== undefined) {
      functionReturnTypes.add(baseKotlinTypeName(stripGenericParameters(type)));
    }
  }

  return {
    packageName,
    annotations,
    annotationImports,
    imports,
    declarations: parseKotlinDeclarations(stripped),
    functionReturnTypes,
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

function parseKotlinDeclarations(source: string): KotlinDeclaration[] {
  const declarations: KotlinDeclaration[] = [];
  const primaryConstructor = String.raw`\((?:[^(){}]|\([^(){}]*\))*\)`;
  const declarationPattern = new RegExp(
    String.raw`\b(?:(?:data|sealed|open|abstract|final|inner|value|annotation)\s+)*(?:(enum)\s+)?(?:(fun)\s+)?(class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^{};]*>)?(?:\s+(?:(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\([^{}]*?\))?|public|private|protected|internal)\s+)*constructor\s*${primaryConstructor}|\s*${primaryConstructor})?(?:\s*:\s*([^{\n]+))?`,
    "gsu",
  );
  for (const match of source.matchAll(declarationPattern)) {
    const rawKind = match[3];
    const name = match[4];
    if (rawKind === undefined || name === undefined) {
      continue;
    }
    declarations.push({
      kind: rawKind as KotlinDeclaration["kind"],
      name,
      supertypes: match[5] === undefined ? [] : kotlinTypeNames(match[5]),
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
  if (/^(?:java|kotlin)\./u.test(full)) {
    return false;
  }
  if (
    full.startsWith("javax.") &&
    !full.startsWith("javax.servlet.") &&
    !full.startsWith("javax.ws.rs.")
  ) {
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

function isKotlinExternalClientImport(full: string): boolean {
  return (
    isNetworkClientImport(full) ||
    full.startsWith("retrofit2.") ||
    full.startsWith("okhttp3.") ||
    full.startsWith("io.ktor.client.") ||
    full.startsWith("io.grpc.") ||
    full.startsWith("software.amazon.awssdk.") ||
    full.startsWith("com.google.cloud.") ||
    full.startsWith("com.azure.")
  );
}

function isAndroidEntrypointImport(full: string): boolean {
  return [
    "android.app.Activity",
    "android.content.BroadcastReceiver",
    "androidx.activity.ComponentActivity",
    "androidx.appcompat.app.AppCompatActivity",
    "androidx.fragment.app.Fragment",
    "androidx.lifecycle.LifecycleService",
  ].includes(full);
}

function isSpringDataPersistenceImport(full: string): boolean {
  return (
    full.startsWith("org.springframework.data.repository.") ||
    full.startsWith("org.springframework.data.jdbc.") ||
    full.startsWith("org.springframework.data.jpa.") ||
    full.startsWith("org.springframework.data.r2dbc.") ||
    full.startsWith("org.springframework.data.mongodb.") ||
    full.startsWith("org.springframework.data.redis.") ||
    full.startsWith("org.springframework.data.cassandra.") ||
    full.startsWith("org.springframework.data.elasticsearch.") ||
    full.startsWith("org.springframework.data.neo4j.") ||
    full.startsWith("org.springframework.data.couchbase.")
  );
}

function javaTypeNames(raw: string): string[] {
  return splitJavaTypeList(raw)
    .map((type) => baseJavaTypeName(stripGenericParameters(type)))
    .filter((type) => type.length > 0);
}

function kotlinTypeNames(raw: string): string[] {
  const parts: string[] = [];
  let angleDepth = 0;
  let parenDepth = 0;
  let current = "";
  for (const char of raw) {
    if (char === "<") {
      angleDepth += 1;
    } else if (char === ">") {
      angleDepth = Math.max(0, angleDepth - 1);
    } else if (char === "(") {
      parenDepth += 1;
    } else if (char === ")") {
      parenDepth = Math.max(0, parenDepth - 1);
    }
    if (char === "," && angleDepth === 0 && parenDepth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts
    .map((type) => baseKotlinTypeName(stripGenericParameters(type)))
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

function baseKotlinTypeName(raw: string): string {
  return (
    raw
      .replace(/\([^()]*\)/gu, "")
      .replace(/\?.*$/su, "")
      .replace(/[^A-Za-z0-9_.]/gu, "")
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

function stripKotlinComments(source: string): string {
  return stripJavaComments(source);
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

function dedupeKotlinEvidence(evidence: KotlinRoleEvidence[]): KotlinRoleEvidence[] {
  const seen = new Set<string>();
  return evidence.filter((item) => {
    const key = `${item.role}:${item.reason}:${item.confidence}`;
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

async function gradleTags(
  root: string,
  buildFile: string,
  sourceFiles: string[],
): Promise<string[]> {
  const tags = ["gradle"];
  if (
    buildFile.endsWith(".kts") ||
    sourceFiles.some((file) => file.endsWith(".kt") || file.endsWith(".kts"))
  ) {
    tags.push("kotlin");
  }
  const buildSource = stripGradleComments(
    await readFile(join(root, buildFile), "utf8").catch(() => ""),
  );
  if (
    appliesAndroidGradlePlugin(buildSource) ||
    /\bandroid\s*\{/u.test(buildSource) ||
    sourceFiles.some((file) => file.endsWith("AndroidManifest.xml"))
  ) {
    tags.push("android");
  }
  return tags;
}

function appliesAndroidGradlePlugin(source: string): boolean {
  const androidPluginId = String.raw`com\.android\.(?:application|library|test|dynamic-feature)`;
  const androidPluginPattern =
    String.raw`\bid\s*(?:\(\s*)?["']${androidPluginId}["']\s*\)?` +
    "|" +
    String.raw`\balias\s*\(\s*libs\.plugins\.[A-Za-z0-9_.]*android[A-Za-z0-9_.]*\s*\)` +
    "|" +
    String.raw`\bapply\s+plugin\s*:\s*["']${androidPluginId}["']` +
    "|" +
    String.raw`\bapply\s*\(\s*plugin\s*=\s*["']${androidPluginId}["']\s*\)`;
  const disabledAndroidPlugin = new RegExp(
    String.raw`(?:${androidPluginPattern})(?:\s*\.version\s*\([^)]*\)|\s+version\s+["'][^"']+["'])?\s*(?:\.apply\s*\(\s*false\s*\)|\bapply\s+false\b)`,
    "giu",
  );
  const activeSource = source.replace(disabledAndroidPlugin, "");
  return new RegExp(androidPluginPattern, "iu").test(activeSource);
}

function stripGradleComments(source: string): string {
  return stripJavaComments(source);
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
