import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { partitionFileGroups } from "./grouping.js";
import {
  associatedJvmTests,
  isExternalProjectImport,
  isNetworkClientImport,
  jvmRoleSeeds,
  parseJavaFile,
} from "./jvm.js";
import { isSampleProjectPath, normalize, pathMatchesPrefix, shouldSkip, walk } from "./shared.js";
import { FeatureSeed } from "./types.js";

const maxOwnedFiles = 12;
const emptyProjectPackages = new Set<string>();
const kotlinBuiltinTypes = new Set([
  "AbstractMethodError",
  "AbstractCollection",
  "AbstractIterator",
  "AbstractList",
  "AbstractMap",
  "AbstractMutableCollection",
  "AbstractMutableList",
  "AbstractMutableMap",
  "AbstractMutableSet",
  "AbstractSet",
  "Annotation",
  "Appendable",
  "ArithmeticException",
  "Any",
  "Array",
  "ArrayDeque",
  "ArrayIndexOutOfBoundsException",
  "ArrayList",
  "AssertionError",
  "AutoCloseable",
  "Boolean",
  "BooleanArray",
  "BooleanIterator",
  "Byte",
  "ByteArray",
  "ByteIterator",
  "Char",
  "CharArray",
  "CharCategory",
  "CharDirection",
  "CharIterator",
  "CharProgression",
  "CharRange",
  "CharSequence",
  "Class",
  "ClassCastException",
  "ClassLoader",
  "ClassNotFoundException",
  "Cloneable",
  "ClosedFloatingPointRange",
  "ClosedRange",
  "Collection",
  "Comparable",
  "Comparator",
  "ConcurrentModificationException",
  "DeepRecursiveFunction",
  "DeepRecursiveScope",
  "Double",
  "DoubleArray",
  "DoubleIterator",
  "Enum",
  "Error",
  "Exception",
  "Float",
  "FloatArray",
  "FloatIterator",
  "Grouping",
  "HashMap",
  "HashSet",
  "IndexedValue",
  "IllegalArgumentException",
  "IllegalMonitorStateException",
  "IllegalStateException",
  "IllegalThreadStateException",
  "IndexOutOfBoundsException",
  "InheritableThreadLocal",
  "Int",
  "Integer",
  "IntArray",
  "IntIterator",
  "IntProgression",
  "IntRange",
  "InterruptedException",
  "InternalError",
  "Iterable",
  "Iterator",
  "KotlinVersion",
  "Lazy",
  "LazyThreadSafetyMode",
  "LinkedHashMap",
  "LinkedHashSet",
  "List",
  "ListIterator",
  "Long",
  "LongArray",
  "LongIterator",
  "LongProgression",
  "LongRange",
  "Map",
  "Math",
  "MatchGroup",
  "MatchGroupCollection",
  "MatchNamedGroupCollection",
  "MatchResult",
  "MutableEntry",
  "MutableCollection",
  "MutableIterable",
  "MutableIterator",
  "MutableList",
  "MutableListIterator",
  "MutableMap",
  "MutableSet",
  "NegativeArraySizeException",
  "NoClassDefFoundError",
  "NoSuchElementException",
  "NoSuchFieldError",
  "NoSuchFieldException",
  "NoSuchMethodError",
  "NoSuchMethodException",
  "NoWhenBranchMatchedException",
  "NullPointerException",
  "Nothing",
  "NotImplementedError",
  "Number",
  "Object",
  "OutOfMemoryError",
  "OpenEndRange",
  "Package",
  "Pair",
  "Process",
  "ProcessBuilder",
  "RandomAccess",
  "Readable",
  "ReflectiveOperationException",
  "Regex",
  "RegexOption",
  "Result",
  "Runnable",
  "Runtime",
  "RuntimeException",
  "SecurityException",
  "Sequence",
  "Set",
  "Short",
  "ShortArray",
  "ShortIterator",
  "String",
  "StringBuffer",
  "StringBuilder",
  "SubclassOptInRequired",
  "System",
  "Thread",
  "ThreadGroup",
  "ThreadLocal",
  "Throwable",
  "Triple",
  "TypeNotPresentException",
  "UByte",
  "UByteArray",
  "UByteIterator",
  "UInt",
  "UIntArray",
  "UIntIterator",
  "UIntProgression",
  "UIntRange",
  "ULong",
  "ULongArray",
  "ULongIterator",
  "ULongProgression",
  "ULongRange",
  "Unit",
  "UninitializedPropertyAccessException",
  "UnknownError",
  "UnsatisfiedLinkError",
  "UnsupportedClassVersionError",
  "UnsupportedOperationException",
  "UShort",
  "UShortArray",
  "UShortIterator",
  "Void",
]);
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
  qualifiedAnnotations: Set<string>;
  unqualifiedAnnotations: Set<string>;
  imports: Map<string, string>;
  declarations: KotlinDeclaration[];
  functionReturnTypes: Set<string>;
};
type ParsedKotlinFile = { filePath: string; info: KotlinFileInfo };
type KotlinProjectIndex = {
  files: ParsedKotlinFile[];
  packages: Set<string>;
  packageTypes: Map<string, Set<string>>;
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
  const projectSourceFiles = await gradleMainSourceFiles(root, moduleRoots);
  const kotlinProjectIndex = await gradleKotlinProjectIndex(root, projectSourceFiles);
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
    const tags = await gradleTags(root, gradleRoot, buildFile, sourceFiles);

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
      const tests = associatedJvmTests(group.files, testFiles);
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
      ...(await kotlinRoleSeeds(
        root,
        buildFile,
        sourceRoot,
        sourceFiles,
        testFiles,
        tags,
        kotlinProjectIndex,
      )),
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

async function gradleKotlinProjectIndex(
  root: string,
  projectSourceFiles: string[],
): Promise<KotlinProjectIndex | null> {
  const files = await gradleKotlinFiles(root, projectSourceFiles, []);
  if (files.length === 0) {
    return null;
  }
  return {
    files,
    packages: await gradleProjectPackages(root, projectSourceFiles, files),
    packageTypes: await kotlinPackageDeclarations(root, projectSourceFiles, files),
  };
}

async function gradleMainSourceFiles(root: string, moduleRoots: string[]): Promise<string[]> {
  const files = new Set<string>();
  for (const moduleRoot of moduleRoots) {
    if ((await gradleBuildFile(root, moduleRoot)) === null) {
      continue;
    }
    const sourceRoot = moduleRoot === "." ? "src" : `${moduleRoot}/src`;
    for (const file of (await walk(root, [sourceRoot]))
      .filter(isGradleSourceFile)
      .filter((path) => !isGradleTestFile(moduleRoot, path))) {
      files.add(file);
    }
  }
  return [...files].toSorted();
}

async function kotlinRoleSeeds(
  root: string,
  buildFile: string,
  sourceRoot: string,
  sourceFiles: string[],
  testFiles: string[],
  tags: string[],
  projectIndex: KotlinProjectIndex | null,
): Promise<FeatureSeed[]> {
  if (projectIndex === null) {
    return [];
  }
  const matches = new Map<
    KotlinRoleKey,
    Map<string, Array<{ reason: string; confidence: FeatureSeed["confidence"] }>>
  >();
  const sourceFileSet = new Set(sourceFiles);
  const kotlinFiles = projectIndex.files.filter(({ filePath }) => sourceFileSet.has(filePath));
  if (kotlinFiles.length === 0) {
    return [];
  }

  for (const { filePath, info } of kotlinFiles) {
    const frameworkEvidence = kotlinFrameworkRoleEvidence(
      info,
      tags,
      projectIndex.packages,
      projectIndex.packageTypes,
    );
    const hasStrongServerRole =
      !tags.includes("android") &&
      frameworkEvidence.some(
        (item) =>
          item.confidence === "high" &&
          item.role !== "server-framework-component" &&
          item.role !== "server-extension-boundary",
      );
    const hasStrongAndroidNonDiRole =
      tags.includes("android") &&
      frameworkEvidence.some(
        (item) =>
          item.confidence === "high" &&
          item.role.startsWith("android-") &&
          item.role !== "android-dependency-injection",
      );
    const pathEvidence = kotlinPathRoleEvidence(filePath, tags).filter(
      (item) =>
        !hasStrongServerRole &&
        !hasStrongAndroidNonDiRole &&
        !frameworkEvidence.some((evidenceItem) => evidenceItem.role === item.role) &&
        !(
          tags.includes("android") &&
          item.role === "android-ui-entrypoint" &&
          frameworkEvidence.some((evidenceItem) =>
            ["android-data-boundary", "android-view-model"].includes(evidenceItem.role),
          )
        ),
    );
    const evidence = [...frameworkEvidence, ...pathEvidence];
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
      const tests = associatedJvmTests(group.files, testFiles);
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

async function gradleKotlinFiles(
  root: string,
  sourceFiles: string[],
  parsedFiles: ParsedKotlinFile[],
): Promise<ParsedKotlinFile[]> {
  const byPath = new Map(parsedFiles.map((file) => [file.filePath, file]));
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".kt"))) {
    if (!byPath.has(filePath)) {
      const source = await readFile(join(root, filePath), "utf8");
      byPath.set(filePath, { filePath, info: parseKotlinFile(source) });
    }
  }
  return [...byPath.values()];
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
  return partitionFileGroups(sourceRoot, [...byFile.keys()], maxOwnedFiles).map((group) => {
    const confidence = kotlinGroupConfidence(group.files, byFile);
    return {
      confidence,
      group,
      label: group.label,
      symbol: group.label,
    };
  });
}

function kotlinGroupConfidence(
  files: string[],
  byFile: Map<string, Array<{ reason: string; confidence: FeatureSeed["confidence"] }>>,
): FeatureSeed["confidence"] {
  return files.some((path) => (byFile.get(path) ?? []).some((item) => item.confidence === "high"))
    ? "high"
    : "medium";
}

function kotlinRoleSource(role: KotlinRoleKey): string {
  if (role.startsWith("android-")) {
    return `kotlin-android-role-${role.slice("android-".length)}`;
  }
  return `kotlin-server-role-${role.slice("server-".length)}`;
}

async function gradleProjectPackages(
  root: string,
  sourceFiles: string[],
  kotlinFiles: ParsedKotlinFile[],
): Promise<Set<string>> {
  const packages = new Set(
    kotlinFiles.flatMap(({ info }) => (info.packageName === null ? [] : [info.packageName])),
  );
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".java"))) {
    const source = await readFile(join(root, filePath), "utf8");
    const packageName = parseJavaFile(source).packageName;
    if (packageName !== null) {
      packages.add(packageName);
    }
  }
  return packages;
}

async function kotlinPackageDeclarations(
  root: string,
  sourceFiles: string[],
  kotlinFiles: ParsedKotlinFile[],
): Promise<Map<string, Set<string>>> {
  const declarations = new Map<string, Set<string>>();
  for (const { info } of kotlinFiles) {
    const packageName = info.packageName ?? "";
    const packageTypes = declarations.get(packageName) ?? new Set<string>();
    for (const declaration of info.declarations) {
      packageTypes.add(declaration.name);
    }
    declarations.set(packageName, packageTypes);
  }
  for (const filePath of sourceFiles.filter((file) => file.endsWith(".java"))) {
    const source = await readFile(join(root, filePath), "utf8");
    const info = parseJavaFile(source);
    const packageName = info.packageName ?? "";
    const packageTypes = declarations.get(packageName) ?? new Set<string>();
    for (const declaration of info.declarations) {
      packageTypes.add(declaration.name);
    }
    declarations.set(packageName, packageTypes);
  }
  return declarations;
}

function kotlinFrameworkRoleEvidence(
  info: KotlinFileInfo,
  tags: string[],
  projectPackages: Set<string>,
  kotlinPackageTypes: Map<string, Set<string>>,
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
    if (!isAndroid && isKotlinServerWebAnnotation(info, annotation)) {
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

  for (const [importedName, full] of info.imports.entries()) {
    if (isAndroid && isAndroidUiEntrypointImport(full)) {
      evidence.push({
        role: "android-ui-entrypoint",
        reason: `Android UI import ${full}`,
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
    if (
      !isAndroid &&
      (isKotlinServerWebAnnotationImportUsed(info, importedName, full) ||
        full.startsWith("io.ktor.server.") ||
        full.startsWith("org.http4k.") ||
        full.startsWith("io.javalin."))
    ) {
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
      if (isAndroid && isAndroidUiEntrypointSupertype(info, type, kotlinPackageTypes)) {
        evidence.push({
          role: "android-ui-entrypoint",
          reason: `inherits Android UI type ${type}`,
          confidence: "high",
        });
      }
      if (isAndroid && isAndroidViewModelSupertype(info, type, kotlinPackageTypes)) {
        evidence.push({
          role: "android-view-model",
          reason: `inherits Android ViewModel type ${type}`,
          confidence: "high",
        });
      }
      if (isAndroid && isAndroidRoomSupertype(info, type, kotlinPackageTypes)) {
        evidence.push({
          role: "android-data-boundary",
          reason: `inherits Room type ${type}`,
          confidence: "high",
        });
      }
    }
  }
  if (!isAndroid) {
    evidence.push(...kotlinDeclarationRoleEvidence(info, projectPackages, kotlinPackageTypes));
    evidence.push(...kotlinFunctionReturnRoleEvidence(info, projectPackages, kotlinPackageTypes));
  }

  return dedupeKotlinEvidence(evidence);
}

function kotlinDeclarationRoleEvidence(
  info: KotlinFileInfo,
  projectPackages: Set<string>,
  kotlinPackageTypes: Map<string, Set<string>>,
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
      const full = kotlinImportForType(info, type, kotlinPackageTypes);
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

function kotlinFunctionReturnRoleEvidence(
  info: KotlinFileInfo,
  projectPackages: Set<string>,
  kotlinPackageTypes: Map<string, Set<string>>,
): KotlinRoleEvidence[] {
  const evidence: KotlinRoleEvidence[] = [];
  for (const type of info.functionReturnTypes) {
    const full = kotlinImportForType(info, type, kotlinPackageTypes);
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
  kotlinPackageTypes: Map<string, Set<string>>,
): string | undefined {
  const [rootType, ...nestedParts] = type.split(".");
  const isNestedType = nestedParts.length > 0;
  if (rootType === undefined || rootType.length === 0) {
    return undefined;
  }
  if (isKotlinStdlibImport(type)) {
    return undefined;
  }
  const packageName = info.packageName ?? "";
  if (
    info.declarations.some((declaration) => declaration.name === rootType) ||
    kotlinPackageTypes.get(packageName)?.has(rootType) === true
  ) {
    return undefined;
  }
  if (isNestedType) {
    const directRoot = info.imports.get(rootType);
    if (directRoot !== undefined) {
      const full = `${directRoot}.${nestedParts.join(".")}`;
      return isKotlinStdlibImport(full) ? undefined : full;
    }
  }
  const direct = info.imports.get(type);
  if (direct !== undefined) {
    return isKotlinStdlibImport(direct) ? undefined : direct;
  }
  if (isKotlinBuiltinType(rootType)) {
    return undefined;
  }
  if (!isNestedType && isKotlinBuiltinType(type)) {
    return undefined;
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*") && kotlinPackageTypes.get(full.slice(0, -2))?.has(rootType) === true) {
      return undefined;
    }
  }
  if (isNestedType && /^[a-z]/u.test(rootType)) {
    return type;
  }
  if (isNestedType) {
    for (const full of info.imports.values()) {
      if (full.endsWith(".*")) {
        if (kotlinPackageTypes.has(full.slice(0, -2))) {
          continue;
        }
        const wildcardType = `${full.slice(0, -1)}${type}`;
        if (isKotlinExternalCandidateImport(wildcardType)) {
          return wildcardType;
        }
      }
    }
    return type;
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*")) {
      if (kotlinPackageTypes.has(full.slice(0, -2))) {
        continue;
      }
      const wildcardType = `${full.slice(0, -1)}${type}`;
      if (isKotlinExternalCandidateImport(wildcardType)) {
        return wildcardType;
      }
    }
  }
  return undefined;
}

function kotlinTypeMatchesImport(
  info: KotlinFileInfo,
  type: string,
  kotlinPackageTypes: Map<string, Set<string>>,
  matches: (full: string) => boolean,
): boolean {
  const full = kotlinImportForType(info, type, kotlinPackageTypes);
  if (full !== undefined && matches(full)) {
    return true;
  }

  const [rootType, ...nestedParts] = type.split(".");
  const isNestedType = nestedParts.length > 0;
  if (rootType === undefined || rootType.length === 0) {
    return false;
  }
  if ((isNestedType && info.imports.has(rootType)) || (!isNestedType && info.imports.has(type))) {
    return false;
  }

  const packageName = info.packageName ?? "";
  if (
    info.declarations.some((declaration) => declaration.name === rootType) ||
    kotlinPackageTypes.get(packageName)?.has(rootType) === true
  ) {
    return false;
  }

  for (const candidate of kotlinWildcardImportCandidates(info, type, kotlinPackageTypes)) {
    if (matches(candidate)) {
      return true;
    }
  }

  return isNestedType && matches(type);
}

function kotlinWildcardImportCandidates(
  info: KotlinFileInfo,
  type: string,
  kotlinPackageTypes: Map<string, Set<string>>,
): string[] {
  const [rootType] = type.split(".");
  if (rootType === undefined || rootType.length === 0) {
    return [];
  }
  for (const full of info.imports.values()) {
    if (full.endsWith(".*") && kotlinPackageTypes.get(full.slice(0, -2))?.has(rootType) === true) {
      return [];
    }
  }
  return [...info.imports.values()]
    .filter((full) => full.endsWith(".*") && !kotlinPackageTypes.has(full.slice(0, -2)))
    .map((full) => `${full.slice(0, -1)}${type}`)
    .filter(isKotlinExternalCandidateImport);
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

function isKotlinBuiltinType(type: string): boolean {
  return kotlinBuiltinTypes.has(type);
}

function isKotlinStdlibImport(full: string): boolean {
  return full.startsWith("kotlin.");
}

function isKotlinExternalCandidateImport(full: string): boolean {
  return isExternalProjectImport(full, emptyProjectPackages);
}

function isKotlinServerWebAnnotation(info: KotlinFileInfo, annotation: string): boolean {
  if (
    ![
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
    ].includes(annotation)
  ) {
    return false;
  }
  for (const full of info.qualifiedAnnotations) {
    if (full.split(".").at(-1) === annotation && isKotlinServerWebImport(full)) {
      return true;
    }
  }
  if (
    !info.unqualifiedAnnotations.has(annotation) &&
    [...info.qualifiedAnnotations].some((full) => full.split(".").at(-1) === annotation)
  ) {
    return false;
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

function isKotlinServerWebAnnotationImportUsed(
  info: KotlinFileInfo,
  importedName: string,
  full: string,
): boolean {
  if (!isKotlinServerWebAnnotationImport(full)) {
    return false;
  }
  if (full.endsWith(".*")) {
    return [...info.unqualifiedAnnotations].some((annotation) =>
      isKotlinServerWebAnnotation(info, annotation),
    );
  }
  return info.unqualifiedAnnotations.has(importedName);
}

function isKotlinServerWebImport(full: string): boolean {
  return (
    isKotlinServerWebAnnotationImport(full) ||
    full.startsWith("io.ktor.server.") ||
    full.startsWith("org.http4k.") ||
    full.startsWith("io.javalin.")
  );
}

function isKotlinServerWebAnnotationImport(full: string): boolean {
  return (
    full.startsWith("org.springframework.web.bind.annotation.") ||
    /^(?:jakarta|javax)\.ws\.rs\./u.test(full)
  );
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
  const qualifiedAnnotations = new Set<string>();
  const unqualifiedAnnotations = new Set<string>();
  for (const match of stripped.matchAll(
    /@(?:[A-Za-z_][A-Za-z0-9_]*:)?([A-Za-z_][A-Za-z0-9_.]*)/gu,
  )) {
    const raw = match[1];
    if (raw !== undefined) {
      annotations.add(raw.split(".").at(-1) ?? raw);
      if (raw.includes(".")) {
        qualifiedAnnotations.add(raw);
      } else {
        unqualifiedAnnotations.add(raw);
      }
    }
  }

  const functionReturnTypes = new Set<string>();
  for (const match of stripped.matchAll(
    /\bfun\s*(?:<[^>{}\n]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.]*\s*\.\s*)?[A-Za-z_][A-Za-z0-9_]*\s*\((?:[^(){}]|\([^(){}]*\))*\)\s*:\s*([^=\n{]+)/gu,
  )) {
    const type = match[1];
    if (type !== undefined) {
      functionReturnTypes.add(kotlinTypeReferenceName(type));
    }
  }

  return {
    packageName,
    annotations,
    qualifiedAnnotations,
    unqualifiedAnnotations,
    imports,
    declarations: parseKotlinDeclarations(stripped),
    functionReturnTypes,
  };
}

function parseKotlinDeclarations(source: string): KotlinDeclaration[] {
  const declarations: KotlinDeclaration[] = [];
  const declarationPattern =
    /\b(?:(?:expect|actual|data|sealed|open|abstract|final|inner|value|annotation)\s+)*(?:(enum)\s+)?(?:(fun)\s+)?(class|interface|object)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s*<[^{};]*>)?(?:(?:\s+(?:(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\([^(){}]*\))?|public|private|protected|internal)\s+)*constructor\s*\((?:[^(){}]|\([^(){}]*\))*\))|(?:\s*\((?:[^(){}]|\([^(){}]*\))*\)))?(?:\s*:\s*([^{}]+?)(?=\s*(?:\{|\n\s*(?:@[A-Za-z_][A-Za-z0-9_.]*(?:\([^(){}]*\))?\s*)*(?:(?:expect|actual|public|private|protected|internal|const|lateinit|suspend|inline|tailrec|operator|infix|external)\s+)*(?:(?:(?:expect|actual|data|sealed|open|abstract|final|inner|value|annotation)\s+)*(?:enum\s+)?(?:fun\s+)?(?:class|interface|object)|fun|val|var|typealias)\s+|$)))?/gsu;
  for (const match of source.matchAll(declarationPattern)) {
    const rawKind = match[3];
    const name = match[4];
    if (rawKind === undefined || name === undefined) {
      continue;
    }
    declarations.push({
      kind: rawKind as KotlinDeclaration["kind"],
      name,
      supertypes: match[5] === undefined ? [] : kotlinSupertypeNames(match[5]),
    });
  }
  return declarations;
}

function isKotlinExternalClientImport(full: string): boolean {
  return (
    isNetworkClientImport(full) ||
    full.startsWith("retrofit2.") ||
    full.startsWith("okhttp3.") ||
    full.startsWith("org.apache.http.") ||
    full.startsWith("io.ktor.client.") ||
    full.startsWith("io.grpc.") ||
    full.startsWith("software.amazon.awssdk.") ||
    full.startsWith("com.google.cloud.") ||
    full.startsWith("com.azure.")
  );
}

function isAndroidUiEntrypointImport(full: string): boolean {
  return [
    "android.app.Activity",
    "android.app.ListActivity",
    "android.app.Service",
    "android.content.BroadcastReceiver",
    "androidx.activity.ComponentActivity",
    "androidx.appcompat.app.AppCompatActivity",
    "androidx.fragment.app.DialogFragment",
    "androidx.fragment.app.Fragment",
    "androidx.lifecycle.LifecycleService",
  ].includes(full);
}

function isAndroidUiEntrypointSupertype(
  info: KotlinFileInfo,
  type: string,
  kotlinPackageTypes: Map<string, Set<string>>,
): boolean {
  return kotlinTypeMatchesImport(info, type, kotlinPackageTypes, isAndroidUiEntrypointImport);
}

function isAndroidViewModelSupertype(
  info: KotlinFileInfo,
  type: string,
  kotlinPackageTypes: Map<string, Set<string>>,
): boolean {
  return kotlinTypeMatchesImport(
    info,
    type,
    kotlinPackageTypes,
    (full) =>
      full === "androidx.lifecycle.ViewModel" || full === "androidx.lifecycle.AndroidViewModel",
  );
}

function isAndroidRoomSupertype(
  info: KotlinFileInfo,
  type: string,
  kotlinPackageTypes: Map<string, Set<string>>,
): boolean {
  return kotlinTypeMatchesImport(
    info,
    type,
    kotlinPackageTypes,
    (full) => full === "androidx.room.RoomDatabase",
  );
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
  return parts.map((type) => kotlinTypeReferenceName(type)).filter((type) => type.length > 0);
}

function kotlinSupertypeNames(raw: string): string[] {
  return kotlinTypeNames(raw.replace(/\s+\bwhere\s+[A-Za-z_][A-Za-z0-9_]*\s*:[\s\S]*$/u, ""));
}

function baseKotlinTypeName(raw: string): string {
  return (
    raw
      .replace(/\([^()]*\)/gu, "")
      .replace(/\?.*$/su, "")
      .split(".")
      .at(-1)
      ?.replace(/[^A-Za-z0-9_]/gu, "")
      .trim() ?? ""
  );
}

function kotlinTypeReferenceName(raw: string): string {
  const type = stripGenericParameters(raw)
    .replace(/\([^()]*\)/gu, "")
    .replace(/\?.*$/su, "")
    .trim();
  if (type.includes(".")) {
    return type.replace(/[^A-Za-z0-9_.]/gu, "");
  }
  return baseKotlinTypeName(type);
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

function stripKotlinComments(source: string): string {
  let stripped = "";
  let index = 0;
  let depth = 0;
  let stringMode: "char" | "double" | "raw" | null = null;
  while (index < source.length) {
    const char = source[index] ?? "";
    const pair = source.slice(index, index + 2);
    const triple = source.slice(index, index + 3);
    if (stringMode === null && pair === "/*") {
      depth += 1;
      stripped += "  ";
      index += 2;
      continue;
    }
    if (depth > 0) {
      if (pair === "*/") {
        depth = Math.max(0, depth - 1);
        stripped += "  ";
        index += 2;
      } else {
        stripped += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }

    if (stringMode === "raw") {
      if (triple === '"""') {
        stringMode = null;
        stripped += "   ";
        index += 3;
      } else {
        stripped += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (stringMode !== null) {
      stripped += char === "\n" ? "\n" : " ";
      if (char === "\\") {
        stripped += source[index + 1] === "\n" ? "\n" : " ";
        index += 2;
        continue;
      }
      if ((stringMode === "double" && char === '"') || (stringMode === "char" && char === "'")) {
        stringMode = null;
      }
      index += 1;
      continue;
    }

    if (triple === '"""') {
      stringMode = "raw";
      stripped += "   ";
      index += 3;
      continue;
    }
    if (char === '"') {
      stringMode = "double";
      stripped += " ";
      index += 1;
      continue;
    }
    if (char === "'") {
      stringMode = "char";
      stripped += " ";
      index += 1;
      continue;
    }
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") {
        stripped += " ";
        index += 1;
      }
      continue;
    }
    stripped += char;
    index += 1;
  }
  return stripped;
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
  const hasSettings = await hasGradleSettings(root, dir);
  if (hasSettings || (await gradleBuildFile(root, dir)) !== null) {
    roots.push(dir);
  }
  if (hasSettings) {
    await discoverNestedGradleRootsInto(root, dir, remainingDepth - 1, roots);
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

async function discoverNestedGradleRootsInto(
  root: string,
  dir: string,
  remainingDepth: number,
  roots: string[],
): Promise<void> {
  if (remainingDepth < 0 || (dir !== "." && (shouldSkip(dir) || isSampleProjectPath(dir)))) {
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
    if (await hasGradleSettings(root, child)) {
      await discoverGradleRootsInto(root, child, remainingDepth, roots);
    } else {
      await discoverNestedGradleRootsInto(root, child, remainingDepth - 1, roots);
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
    if (await hasGradleSettings(root, child)) {
      continue;
    }
    if ((await gradleBuildFile(root, child)) !== null) {
      modules.add(child);
    }
    await collectGradleModules(root, child, remainingDepth - 1, modules);
  }
}

async function hasGradleSettings(root: string, moduleRoot: string): Promise<boolean> {
  const full = moduleRoot === "." ? root : join(root, moduleRoot);
  return (
    (await pathExists(join(full, "settings.gradle"))) ||
    (await pathExists(join(full, "settings.gradle.kts")))
  );
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

async function gradleTags(
  root: string,
  gradleRoot: string,
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
  const [buildSource, androidAliases] = await Promise.all([
    readFile(join(root, buildFile), "utf8").catch(() => ""),
    androidVersionCatalogPluginAliases(root, gradleRoot, buildFile),
  ]);
  if (
    sourceFiles.some((file) => file.endsWith("AndroidManifest.xml")) ||
    hasAndroidExtensionBlock(buildSource, buildFile.endsWith(".kts")) ||
    hasAppliedAndroidPlugin(buildSource, androidAliases, buildFile.endsWith(".kts"))
  ) {
    tags.push("android");
  }
  return tags;
}

async function androidVersionCatalogPluginAliases(
  root: string,
  gradleRoot: string,
  buildFile: string,
): Promise<Set<string>> {
  const aliases = new Set<string>();
  for (const path of versionCatalogPaths(buildFile, gradleRoot)) {
    const source = await readFile(join(root, path), "utf8").catch(() => null);
    if (source === null) {
      continue;
    }
    for (const alias of parseAndroidPluginAliases(source)) {
      aliases.add(alias);
    }
  }
  return aliases;
}

function versionCatalogPaths(_buildFile: string, gradleRoot: string): string[] {
  return [
    gradleRoot === "." ? "gradle/libs.versions.toml" : `${gradleRoot}/gradle/libs.versions.toml`,
  ];
}

function parseAndroidPluginAliases(source: string): Set<string> {
  const aliases = new Set<string>();
  let inPlugins = false;
  let pluginTableAlias: string | null = null;
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.replace(/#.*/u, "").trim();
    if (line.length === 0) {
      continue;
    }
    const section = /^\[([^\]]+)\]$/u.exec(line)?.[1];
    if (section !== undefined) {
      const sectionKey = tomlDottedKey(section);
      inPlugins = sectionKey === "plugins" || sectionKey.startsWith("plugins.");
      pluginTableAlias = sectionKey.startsWith("plugins.")
        ? sectionKey.slice("plugins.".length)
        : null;
      continue;
    }
    const topLevelPluginAlias = androidTopLevelPluginAliasForLine(line);
    if (topLevelPluginAlias !== undefined) {
      aliases.add(normalizeVersionCatalogAlias(topLevelPluginAlias));
      continue;
    }
    if (!inPlugins || !/com\.android\.(?:application|library|dynamic-feature|test)/u.test(line)) {
      continue;
    }
    const alias = androidPluginAliasForLine(line, pluginTableAlias);
    if (alias !== undefined) {
      aliases.add(normalizeVersionCatalogAlias(alias));
    }
  }
  return aliases;
}

function androidTopLevelPluginAliasForLine(line: string): string | undefined {
  if (!/com\.android\.(?:application|library|dynamic-feature|test)/u.test(line)) {
    return undefined;
  }
  return tomlPluginAliasKey(
    /^plugins\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+?))(?:\.id)?\s*=/u.exec(line),
  );
}

function androidPluginAliasForLine(
  line: string,
  pluginTableAlias: string | null,
): string | undefined {
  const rawKey = tomlPluginAliasKey(
    /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+?))(?:\.id)?\s*=/u.exec(line),
  );
  if (pluginTableAlias === null || rawKey === undefined || rawKey === "id") {
    return pluginTableAlias ?? rawKey;
  }
  return `${pluginTableAlias}.${rawKey}`;
}

function tomlPluginAliasKey(match: RegExpExecArray | null): string | undefined {
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function tomlDottedKey(key: string): string {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < key.length; index += 1) {
    const char = key[index] ?? "";
    if (quote !== null) {
      if (char === "\\" && quote === '"') {
        current += char;
        index += 1;
        current += key[index] ?? "";
        continue;
      }
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ".") {
      segments.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  segments.push(current.trim());
  return segments.filter((segment) => segment.length > 0).join(".");
}

function hasAppliedAndroidPlugin(
  buildSource: string,
  androidAliases: Set<string>,
  isKotlinDsl: boolean,
): boolean {
  const source = stripGradleBuildComments(buildSource, isKotlinDsl);
  for (const pluginBlock of rootGradlePluginBlocks(source)) {
    for (const match of pluginBlock.matchAll(androidPluginDeclarationPattern())) {
      const start = match.index ?? 0;
      if (!hasGradleApplyFalse(pluginBlock, start)) {
        return true;
      }
    }
    for (const match of pluginBlock.matchAll(
      /\balias\s*\(\s*libs\.plugins\.([A-Za-z0-9_.]+)\s*\)/gu,
    )) {
      const alias = match[1];
      if (
        alias !== undefined &&
        androidAliases.has(normalizeVersionCatalogAlias(alias)) &&
        !hasGradleApplyFalse(pluginBlock, match.index ?? 0)
      ) {
        return true;
      }
    }
  }
  return hasDirectAndroidApplyPlugin(source);
}

function rootGradlePluginBlocks(source: string): string[] {
  const blocks: string[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char !== "{") {
      continue;
    }
    const prefix = source.slice(Math.max(0, index - 100), index).trimEnd();
    if (!/\bplugins\s*$/u.test(prefix) || isInsideGradleChildProjectBlock(source, index)) {
      continue;
    }
    const end = gradleBlockEnd(source, index);
    blocks.push(source.slice(index + 1, end));
    index = end;
  }
  return blocks;
}

function gradleBlockEnd(source: string, openBrace: number): number {
  let quote: "'" | '"' | null = null;
  let depth = 1;
  for (let index = openBrace + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return source.length;
}

function stripGradleBuildComments(source: string, supportsNestedBlockComments: boolean): string {
  let stripped = "";
  let index = 0;
  let quote: "'" | '"' | null = null;
  let blockDepth = 0;
  while (index < source.length) {
    const char = source[index] ?? "";
    const pair = source.slice(index, index + 2);
    if (blockDepth > 0) {
      if (supportsNestedBlockComments && pair === "/*") {
        blockDepth += 1;
        stripped += "  ";
        index += 2;
      } else if (pair === "*/") {
        blockDepth = Math.max(0, blockDepth - 1);
        stripped += "  ";
        index += 2;
      } else {
        stripped += char === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      stripped += char;
      if (char === "\\") {
        stripped += source[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      stripped += char;
      index += 1;
      continue;
    }
    if (pair === "//") {
      while (index < source.length && source[index] !== "\n") {
        stripped += " ";
        index += 1;
      }
      continue;
    }
    if (pair === "/*") {
      blockDepth = 1;
      stripped += "  ";
      index += 2;
      continue;
    }
    stripped += char;
    index += 1;
  }
  return stripped;
}

function hasDirectAndroidApplyPlugin(source: string): boolean {
  const pattern =
    /\b(?:apply\s+plugin\s*:\s*["']com\.android\.(?:application|library|dynamic-feature|test)["']|apply\s*\(\s*plugin\s*(?:=|:)\s*["']com\.android\.(?:application|library|dynamic-feature|test)["']\s*\))/gu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (!isInsideGradleString(source, start) && !isInsideGradleChildProjectBlock(source, start)) {
      return true;
    }
  }
  return false;
}

function hasAndroidExtensionBlock(buildSource: string, isKotlinDsl: boolean): boolean {
  const source = stripGradleBuildComments(buildSource, isKotlinDsl);
  for (const match of source.matchAll(/\bandroid\s*\{/gu)) {
    const start = match.index ?? 0;
    if (!isInsideGradleString(source, start) && !isInsideGradleChildProjectBlock(source, start)) {
      return true;
    }
  }
  return false;
}

function isInsideGradleString(source: string, offset: number): boolean {
  let quote: "'" | '"' | null = null;
  let tripleQuote: "'" | '"' | null = null;
  for (let index = 0; index < offset; index += 1) {
    const char = source[index] ?? "";
    const triple = source.slice(index, index + 3);
    if (tripleQuote !== null) {
      if (triple === tripleQuote.repeat(3)) {
        tripleQuote = null;
        index += 2;
      }
      continue;
    }
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (triple === '"""' || triple === "'''") {
      tripleQuote = char as "'" | '"';
      index += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    }
  }
  return quote !== null || tripleQuote !== null;
}

function isInsideGradleChildProjectBlock(source: string, offset: number): boolean {
  const scopes: boolean[] = [];
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < offset; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "{") {
      const prefix = source.slice(Math.max(0, index - 100), index).trimEnd();
      const childProjectScope =
        /\bsubprojects\s*$/u.test(prefix) ||
        /\bsubprojects\.configureEach\s*$/u.test(prefix) ||
        /\bconfigure\s*\(\s*subprojects\s*\)\s*$/u.test(prefix) ||
        /\bproject\s*\([^)]*\)\s*$/u.test(prefix);
      scopes.push((scopes.at(-1) ?? false) || childProjectScope);
    } else if (char === "}") {
      scopes.pop();
    }
  }
  return scopes.includes(true);
}

function hasGradleApplyFalse(source: string, start: number): boolean {
  const segmentEnd = gradlePluginInvocationEnd(source, start);
  const segment = source.slice(start, segmentEnd);
  return /\bapply\s+false\b|\.\s*apply\s*\(\s*false\s*\)/u.test(segment);
}

function androidPluginDeclarationPattern(): RegExp {
  return /\b(?:id\s*\(?\s*["']com\.android\.(?:application|library|dynamic-feature|test)["']\s*\)?|alias\s*\(\s*libs\.plugins\.[A-Za-z0-9_.]*android[A-Za-z0-9_.]*\s*\))/giu;
}

function gradlePluginInvocationEnd(source: string, start: number): number {
  let quote: "'" | '"' | null = null;
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote !== null) {
      if (char === "\\") {
        index += 1;
        continue;
      }
      if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === ";" || char === "}") {
      return index;
    }
    if (
      char === "\n" &&
      /^\s*(?:id\s*(?:\(|["'])|alias\s*\(|kotlin\s*\(|`[^`]+`|[A-Za-z_][A-Za-z0-9_]*\s+(?:apply|version)\b)/u.test(
        source.slice(index + 1),
      )
    ) {
      return index;
    }
  }
  return source.length;
}

function normalizeVersionCatalogAlias(alias: string): string {
  return alias.replace(/[-_]/gu, ".").toLowerCase();
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
