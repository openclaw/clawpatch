import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
import {
  fileHasRubyShebang,
  rubyDependencyNames,
  rubyGemspecPaths,
  stripRubyComments,
} from "../ruby.js";
import {
  isSafeDirectory,
  isSafeFile,
  packageKind,
  packageTrustBoundaries,
  pathMatchesPrefix,
  shouldSkip,
  walk,
} from "./shared.js";
import { FeatureSeed, SeedFileRef, SeedTestRef } from "./types.js";
import { TrustBoundary } from "../types.js";

type SourceGroup = {
  label: string;
  files: string[];
};

type RubyProjectInfo = {
  name: string | null;
  dependencies: Set<string>;
  hasRspec: boolean;
  hasMinitest: boolean;
};

const metadataFiles = ["Gemfile", "gems.rb", "Rakefile", "config.ru"] as const;
const sourceRoots = ["app", "lib", "scripts"] as const;
const executableRoots = ["exe", "bin", "script"] as const;
const railsBinstubs = new Set(["bundle", "rails", "rake", "setup", "spring", "yarn"]);
const sourceGroupMaxOwnedFiles = 12;
const sourceGroupMaxTests = 8;
const jekyllContentMaxOwnedFiles = 24;
const rootToolingFiles = new Set([
  "Gemfile.lock",
  "README.md",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
]);

export async function rubySeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await isRubyProject(root))) {
    return [];
  }
  const info = await rubyProjectInfo(root);
  const projectFiles = await rubyMetadataFiles(root);
  const testFiles = await rubyTestFiles(root);
  const runPrefix = await rubyRunPrefix(root);
  const testCommand = rubyProjectTestCommand(runPrefix, info, testFiles);
  const commandForTest = (path: string): string | null =>
    rubyTestCommandForPath(path, runPrefix, info);
  const railsApp = await isRailsApp(root, info);
  const seeds: FeatureSeed[] = [];

  if (projectFiles.length > 0) {
    seeds.push({
      title: `Ruby project ${info.name ?? basename(root)}`,
      summary: `Ruby project metadata in ${projectFiles.join(", ")}.`,
      kind: packageKind(info.name ?? basename(root)),
      source: "ruby-project",
      confidence: "medium",
      entryPath: projectFiles[0] ?? "Gemfile",
      symbol: info.name,
      route: null,
      command: null,
      ownedFiles: projectFiles.map((path) => ({ path, reason: "ruby project metadata" })),
      contextFiles: await rubyProjectContextFiles(root, projectFiles),
      tags: ["ruby", "package"],
      trustBoundaries: rubyTrustBoundaries(info.name ?? basename(root), info.dependencies),
      skipNearbyTests: true,
    });
  }

  for (const executable of await rubyExecutables(root, railsApp)) {
    const tests = associatedTests([executable], testFiles, commandForTest);
    seeds.push({
      title: `Ruby CLI command ${basename(executable)}`,
      summary: `Ruby executable ${executable}.`,
      kind: "cli-command",
      source: "ruby-executable",
      confidence: "high",
      entryPath: executable,
      symbol: null,
      route: null,
      command: basename(executable),
      ownedFiles: [{ path: executable, reason: "ruby executable" }],
      contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
      tests,
      tags: ["ruby", "cli"],
      trustBoundaries: ["user-input", "filesystem", "process-exec"],
      testCommand,
      skipNearbyTests: true,
    });
  }

  if (projectFiles.includes("Rakefile")) {
    seeds.push({
      title: "Ruby Rake tasks",
      summary: "Ruby Rakefile task definitions.",
      kind: "release",
      source: "ruby-rakefile",
      confidence: "medium",
      entryPath: "Rakefile",
      symbol: null,
      route: null,
      command: "rake",
      ownedFiles: [{ path: "Rakefile", reason: "rake task definitions" }],
      contextFiles: [],
      tests: [],
      tags: ["ruby", "rake"],
      trustBoundaries: ["filesystem", "process-exec"],
      skipNearbyTests: true,
    });
  }

  for (const group of await rubySourceGroups(root)) {
    const tests = associatedTests(group.files, testFiles, commandForTest);
    seeds.push({
      title: `Ruby source ${group.label}`,
      summary:
        group.files.length === 1
          ? `Ruby source file ${group.files[0]}.`
          : `Ruby source group ${group.label} with ${group.files.length} files.`,
      kind: packageKind(group.label),
      source: "ruby-source-group",
      confidence: "medium",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `source group ${group.label}` })),
      contextFiles: tests.map((test) => ({ path: test.path, reason: "associated test" })),
      tests,
      tags: ["ruby", "source-group"],
      trustBoundaries: rubyTrustBoundaries(group.label, info.dependencies),
      testCommand,
      skipNearbyTests: true,
    });
  }

  seeds.push(...(await jekyllSeeds(root, info)));
  seeds.push(...(await railsSeeds(root, info)));

  for (const testSuite of standaloneTestSuites(testFiles, commandForTest)) {
    seeds.push(testSuite);
  }

  return seeds;
}

async function isRubyProject(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "Gemfile"))) ||
    (await pathExists(join(root, "gems.rb"))) ||
    (await pathExists(join(root, "Rakefile"))) ||
    (await pathExists(join(root, "config.ru"))) ||
    (await rubyGemspecs(root)).length > 0 ||
    (await rootRubySourceFiles(root)).length > 0 ||
    (await containsReviewableRubySource(root))
  );
}

async function rubyProjectInfo(root: string): Promise<RubyProjectInfo> {
  const source = stripRubyComments(await rubyDependencySource(root));
  return {
    name: rubyProjectName(source),
    dependencies: rubyDependencyNames(source),
    hasRspec: /\brspec\b/iu.test(source),
    hasMinitest: /\bminitest\b/iu.test(source),
  };
}

async function rubyMetadataFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const path of metadataFiles) {
    if (await pathExists(join(root, path))) {
      files.push(path);
    }
  }
  files.push(...(await rubyGemspecs(root)));
  return files.toSorted();
}

async function rubyGemspecs(root: string): Promise<string[]> {
  return rubyGemspecPaths(root, { includeNested: true });
}

async function rubyDependencySource(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const path of [...metadataFiles, ...(await rubyGemspecPaths(root))]) {
    if (await pathExists(join(root, path))) {
      chunks.push(await readFile(join(root, path), "utf8"));
    }
  }
  return chunks.join("\n");
}

function rubyProjectName(source: string): string | null {
  const assignment = /^\s*[A-Za-z_][A-Za-z0-9_]*\.name\s*=\s*(.+)$/mu.exec(source)?.[1];
  return assignment === undefined ? null : rubyStringLiteral(assignment);
}

function rubyStringLiteral(source: string): string | null {
  const trimmed = source.trimStart();
  const quoted = /^(['"])(.*?)\1/u.exec(trimmed)?.[2];
  if (quoted !== undefined) {
    return quoted;
  }
  const percent = /^%[qQ]([<{[(]|[^A-Za-z0-9\s])/.exec(trimmed)?.[1];
  if (percent === undefined) {
    return null;
  }
  const close =
    new Map([
      ["<", ">"],
      ["{", "}"],
      ["[", "]"],
      ["(", ")"],
    ]).get(percent) ?? percent;
  const rest = trimmed.slice(3);
  const end = rest.indexOf(close);
  return end === -1 ? null : rest.slice(0, end);
}

function rubyTrustBoundaries(name: string, dependencies: Set<string>): TrustBoundary[] {
  const boundaries = new Set<TrustBoundary>(packageTrustBoundaries(name));
  const text = `${name} ${[...dependencies].join(" ")}`;
  if (/\b(redis|sequel|pg|mysql2?|sqlite3?|activerecord)\b/iu.test(text)) {
    boundaries.add("database");
    boundaries.add("network");
    boundaries.add("serialization");
  }
  if (/\b(faraday|http|net-http|mechanize|rest-client|hive|steem|rpc|api)\b/iu.test(text)) {
    boundaries.add("network");
    boundaries.add("external-api");
    boundaries.add("serialization");
  }
  if (/\b(json|oj|msgpack|yaml|xml)\b/iu.test(text)) {
    boundaries.add("serialization");
  }
  return [...boundaries];
}

function uniqueTrustBoundaries(values: TrustBoundary[]): TrustBoundary[] {
  return [...new Set(values)];
}

async function rubyProjectContextFiles(
  root: string,
  ownedMetadataFiles: readonly string[],
): Promise<SeedFileRef[]> {
  const refs: SeedFileRef[] = [];
  const owned = new Set(ownedMetadataFiles);
  for (const path of ["Gemfile.lock", "gems.locked", ".rubocop.yml", "README.md"]) {
    if (!owned.has(path) && (await pathExists(join(root, path)))) {
      refs.push({ path, reason: "ruby project context" });
    }
  }
  return refs;
}

async function jekyllSeeds(root: string, info: RubyProjectInfo): Promise<FeatureSeed[]> {
  if (!(await isJekyllSite(root, info))) {
    return [];
  }
  const seeds: FeatureSeed[] = [];
  const trustBoundaries = rubyTrustBoundaries("jekyll site", info.dependencies);
  const rootPages = await jekyllRootPages(root);
  const configFiles = await existingFiles(root, ["_config.yml", "CNAME", "authors.json"]);
  if (configFiles.length > 0 || rootPages.length > 0) {
    seeds.push({
      title: "Jekyll site configuration",
      summary: "Jekyll configuration and top-level site pages.",
      kind: "config",
      source: "jekyll-site-config",
      confidence: "high",
      entryPath: configFiles[0] ?? rootPages[0] ?? "_config.yml",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: [
        ...configFiles.map((path) => ({ path, reason: "jekyll site configuration" })),
        ...rootPages.map((path) => ({ path, reason: "top-level jekyll page" })),
      ],
      contextFiles: [],
      tags: ["ruby", "jekyll", "site"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  const themeFiles = await jekyllThemeFiles(root);
  for (const group of jekyllThemeGroups(themeFiles)) {
    seeds.push({
      title: `Jekyll theme ${group.label}`,
      summary: `Jekyll layouts, includes, Sass, or static assets with ${group.files.length} file(s).`,
      kind: "ui-flow",
      source: "jekyll-theme",
      confidence: "high",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: "jekyll theme file" })),
      contextFiles: configFiles.map((path) => ({ path, reason: "jekyll site configuration" })),
      tags: ["ruby", "jekyll", "theme"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  for (const group of await jekyllContentGroups(root)) {
    seeds.push({
      title: `Jekyll content ${group.label}`,
      summary: `Jekyll Markdown content group ${group.label} with ${group.files.length} file(s).`,
      kind: "route",
      source: "jekyll-content",
      confidence: "high",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `jekyll content ${group.label}` })),
      contextFiles: configFiles.map((path) => ({ path, reason: "jekyll site configuration" })),
      tags: ["ruby", "jekyll", "content"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  return seeds;
}

async function isJekyllSite(root: string, info: RubyProjectInfo): Promise<boolean> {
  return (await pathExists(join(root, "_config.yml"))) && info.dependencies.has("jekyll");
}

async function railsSeeds(root: string, info: RubyProjectInfo): Promise<FeatureSeed[]> {
  if (!(await isRailsApp(root, info))) {
    return [];
  }
  const trustBoundaries = rubyTrustBoundaries("rails app", info.dependencies);
  const seeds: FeatureSeed[] = [];
  const configFiles = await railsConfigFiles(root);
  if (configFiles.length > 0) {
    seeds.push({
      title: "Rails application configuration",
      summary: "Rails routes, environments, initializers, and application configuration.",
      kind: "config",
      source: "rails-config",
      confidence: "high",
      entryPath: "config/application.rb",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: configFiles.map((path) => ({ path, reason: "rails configuration" })),
      contextFiles: [],
      tags: ["ruby", "rails", "config"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  const dbFiles = await railsDatabaseFiles(root);
  for (const group of partitionSourceFiles("db", dbFiles, sourceGroupMaxOwnedFiles)) {
    seeds.push({
      title:
        group.label === "db"
          ? "Rails database schema and migrations"
          : `Rails database schema and migrations ${group.label}`,
      summary: `Rails database group ${group.label} with ${group.files.length} migration/schema file(s).`,
      kind: "service",
      source: "rails-database",
      confidence: "high",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({
        path,
        reason: `rails database group ${group.label}`,
      })),
      contextFiles: [],
      tags: ["ruby", "rails", "database"],
      trustBoundaries: uniqueTrustBoundaries([...trustBoundaries, "database"]),
      skipNearbyTests: true,
    });
  }

  for (const group of await railsViewGroups(root)) {
    seeds.push({
      title: `Rails views ${group.label}`,
      summary: `Rails view/template group ${group.label} with ${group.files.length} file(s).`,
      kind: "ui-flow",
      source: "rails-views",
      confidence: "high",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `rails views ${group.label}` })),
      contextFiles: configFiles
        .filter((path) => path === "config/routes.rb")
        .map((path) => ({ path, reason: "rails routes" })),
      tags: ["ruby", "rails", "views"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  for (const group of await railsAssetGroups(root)) {
    seeds.push({
      title: `Rails assets ${group.label}`,
      summary: `Rails asset group ${group.label} with ${group.files.length} file(s).`,
      kind: "ui-flow",
      source: "rails-assets",
      confidence: "high",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: `rails assets ${group.label}` })),
      contextFiles: [],
      tags: ["ruby", "rails", "assets"],
      trustBoundaries,
      skipNearbyTests: true,
    });
  }

  return seeds;
}

async function isRailsApp(root: string, info: RubyProjectInfo): Promise<boolean> {
  return info.dependencies.has("rails") && (await pathExists(join(root, "config/application.rb")));
}

async function railsConfigFiles(root: string): Promise<string[]> {
  const files = await existingFiles(root, [
    "config/application.rb",
    "config/routes.rb",
    "config/environment.rb",
    "config/boot.rb",
  ]);
  for (const prefix of ["config/environments", "config/initializers", "config/locales"]) {
    if (!(await isSafeDirectory(root, join(root, prefix)))) {
      continue;
    }
    files.push(
      ...(await walk(root, [prefix])).filter(
        (path) =>
          /\.(rb|ya?ml)$/u.test(path) && !rubyShouldSkip(path) && !isSensitiveRailsConfig(path),
      ),
    );
  }
  return uniquePathsInOrder(files);
}

function isSensitiveRailsConfig(path: string): boolean {
  return /^config\/initializers\/(?:secret_token|secret_key_base)\.rb$/u.test(path);
}

async function railsDatabaseFiles(root: string): Promise<string[]> {
  if (!(await isSafeDirectory(root, join(root, "db")))) {
    return [];
  }
  return (await walk(root, ["db"]))
    .filter((path) => /\.(rb|ya?ml|sql)$/u.test(path) && !rubyShouldSkip(path))
    .toSorted();
}

async function railsViewGroups(root: string): Promise<SourceGroup[]> {
  if (!(await isSafeDirectory(root, join(root, "app/views")))) {
    return [];
  }
  const files = (await walk(root, ["app/views"])).filter(
    (path) => /\.(erb|haml|slim|builder|jbuilder|coffee)$/u.test(path) && !rubyShouldSkip(path),
  );
  return partitionSourceFiles("app/views", files, jekyllContentMaxOwnedFiles);
}

async function railsAssetGroups(root: string): Promise<SourceGroup[]> {
  const hasNodePackage = await pathExists(join(root, "package.json"));
  const roots = ["app/assets", "app/javascript", "app/packs", "app/frontend"];
  const groups: SourceGroup[] = [];
  for (const prefix of roots) {
    if (!(await isSafeDirectory(root, join(root, prefix)))) {
      continue;
    }
    const files = (await walk(root, [prefix])).filter(
      (path) =>
        isRailsAssetFile(path, hasNodePackage) &&
        !rubyShouldSkip(path) &&
        !pathMatchesPrefix(path, "app/assets/builds") &&
        !path.includes("/images/"),
    );
    groups.push(...partitionSourceFiles(prefix, files, jekyllContentMaxOwnedFiles));
  }
  return groups;
}

function isRailsAssetFile(path: string, hasNodePackage: boolean): boolean {
  if (hasNodePackage && !pathMatchesPrefix(path, "app/assets")) {
    return /\.(coffee|css|scss|sass)$/u.test(path);
  }
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs|coffee|css|scss|sass)$/u.test(path);
}

async function existingFiles(root: string, candidates: string[]): Promise<string[]> {
  const files: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(join(root, candidate))) {
      files.push(candidate);
    }
  }
  return files;
}

async function jekyllRootPages(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((path) => /\.(md|html|json)$/u.test(path))
    .filter((path) => !rootToolingFiles.has(path))
    .toSorted();
}

async function jekyllThemeFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const prefix of ["_layouts", "_includes", "_sass", "assets"]) {
    if (!(await isSafeDirectory(root, join(root, prefix)))) {
      continue;
    }
    files.push(
      ...(await walk(root, [prefix])).filter(
        (path) =>
          /\.(html|liquid|scss|sass|css|js)$/u.test(path) &&
          !rubyShouldSkip(path) &&
          !path.startsWith("assets/images/"),
      ),
    );
  }
  return uniquePaths(files);
}

function jekyllThemeGroups(files: string[]): SourceGroup[] {
  const groups = new Map<string, string[]>();
  for (const file of files) {
    const label = file.split("/")[0] ?? "assets";
    groups.set(label, [...(groups.get(label) ?? []), file]);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([label, groupedFiles]) =>
      chunkFiles(label, groupedFiles.toSorted(), jekyllContentMaxOwnedFiles),
    );
}

async function jekyllContentGroups(root: string): Promise<SourceGroup[]> {
  const groups: SourceGroup[] = [];
  const posts = await jekyllPosts(root);
  for (const [year, files] of groupByPostYear(posts)) {
    groups.push(...chunkFiles(`_posts/${year}`, files, jekyllContentMaxOwnedFiles));
  }
  for (const prefix of ["_topics"]) {
    if (!(await isSafeDirectory(root, join(root, prefix)))) {
      continue;
    }
    const files = (await walk(root, [prefix])).filter(
      (path) => /\.(md|html)$/u.test(path) && !rubyShouldSkip(path),
    );
    groups.push(...partitionSourceFiles(prefix, files, jekyllContentMaxOwnedFiles));
  }
  return groups;
}

async function jekyllPosts(root: string): Promise<string[]> {
  if (!(await isSafeDirectory(root, join(root, "_posts")))) {
    return [];
  }
  return (await walk(root, ["_posts"]))
    .filter((path) => /^_posts\/\d{4}-\d{2}-\d{2}-.+\.md$/u.test(path))
    .toSorted();
}

function groupByPostYear(posts: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const post of posts) {
    const year = /^_posts\/(\d{4})-/u.exec(post)?.[1] ?? "unknown";
    groups.set(year, [...(groups.get(year) ?? []), post]);
  }
  return new Map([...groups.entries()].toSorted(([left], [right]) => left.localeCompare(right)));
}

async function rubyExecutables(root: string, skipRailsBinstubs: boolean): Promise<string[]> {
  const executables: string[] = [];
  for (const executableRoot of await rubyExecutableRoots(root)) {
    if (!(await isSafeDirectory(root, join(root, executableRoot)))) {
      continue;
    }
    for (const path of await walk(root, [executableRoot])) {
      if (
        skipRailsBinstubs &&
        executableRoot.endsWith("bin") &&
        railsBinstubs.has(basename(path))
      ) {
        continue;
      }
      if (
        !rubyShouldSkip(path) &&
        (path.endsWith(".rb") ||
          (isRubyShebangCandidate(path) && (await hasRubyShebang(root, path))))
      ) {
        executables.push(path);
      }
    }
  }
  return executables.toSorted();
}

async function hasRubyShebang(root: string, path: string): Promise<boolean> {
  if (!(await isSafeFile(root, join(root, path)))) {
    return false;
  }
  return fileHasRubyShebang(join(root, path));
}

async function rubySourceGroups(root: string): Promise<SourceGroup[]> {
  const groups: SourceGroup[] = [];
  groups.push(...(await rootRubySourceGroups(root)));
  for (const sourceRoot of await rubySourceRoots(root)) {
    if (!(await isSafeDirectory(root, join(root, sourceRoot)))) {
      continue;
    }
    const files = (await walk(root, [sourceRoot])).filter(isReviewableRubySourceFile);
    groups.push(...partitionSourceFiles(sourceRoot, files, sourceGroupMaxOwnedFiles));
  }
  return groups;
}

async function rootRubySourceGroups(root: string): Promise<SourceGroup[]> {
  return chunkFiles("root", await rootRubySourceFiles(root), sourceGroupMaxOwnedFiles);
}

async function rootRubySourceFiles(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && isReviewableRubySourceFile(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

async function rubyTestFiles(root: string): Promise<string[]> {
  const rootTests = await rootRubyTestFiles(root);
  const files = (await walk(root, await rubyTestRoots(root)))
    .filter(isRubyTestPath)
    .filter((path) => !rubyShouldSkip(path) && !isRubyFixturePath(path));
  return uniquePaths([...rootTests, ...files]).slice(0, 200);
}

async function rubySourceRoots(root: string): Promise<string[]> {
  const roots: string[] = [...sourceRoots];
  for (const packageRoot of await nestedRubyPackageRoots(root)) {
    roots.push(...sourceRoots.map((sourceRoot) => `${packageRoot}/${sourceRoot}`));
  }
  return uniquePaths(roots);
}

async function rubyExecutableRoots(root: string): Promise<string[]> {
  const roots: string[] = [...executableRoots];
  for (const packageRoot of await nestedRubyPackageRoots(root)) {
    roots.push(...executableRoots.map((executableRoot) => `${packageRoot}/${executableRoot}`));
  }
  return uniquePaths(roots);
}

async function rubyTestRoots(root: string): Promise<string[]> {
  const roots = ["spec", "test", ...(await rubySourceRoots(root))];
  for (const packageRoot of await nestedRubyPackageRoots(root)) {
    roots.push(`${packageRoot}/spec`, `${packageRoot}/test`);
  }
  return uniquePaths(roots);
}

async function nestedRubyPackageRoots(root: string): Promise<string[]> {
  const packageRoots = new Set<string>();
  for (const gemspec of await rubyGemspecs(root)) {
    const packageRoot = dirname(gemspec);
    if (
      packageRoot !== "." &&
      !rubyShouldSkip(packageRoot) &&
      (await isSafeDirectory(root, join(root, packageRoot)))
    ) {
      packageRoots.add(packageRoot);
    }
  }
  return [...packageRoots].toSorted();
}

async function rootRubyTestFiles(root: string): Promise<string[]> {
  return (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((entry) => entry.isFile() && isRubyTestPath(entry.name))
    .map((entry) => entry.name)
    .toSorted();
}

async function rubyRunPrefix(root: string): Promise<string> {
  return (await pathExists(join(root, "Gemfile"))) || (await pathExists(join(root, "gems.rb")))
    ? "bundle exec "
    : "";
}

function rubyProjectTestCommand(
  runPrefix: string,
  info: RubyProjectInfo,
  testFiles: string[],
): string | null {
  if (info.hasRspec || testFiles.some((path) => path.endsWith("_spec.rb"))) {
    return `${runPrefix}rspec`;
  }
  if (info.hasMinitest || testFiles.some((path) => path.endsWith("_test.rb"))) {
    return `${runPrefix}rake test`;
  }
  return null;
}

function rubyTestCommandForPath(
  path: string,
  runPrefix: string,
  info: RubyProjectInfo,
): string | null {
  if (path.endsWith("_spec.rb") || (path.startsWith("spec/") && info.hasRspec)) {
    return `${runPrefix}rspec`;
  }
  if (isRubyMinitestPath(path) || (path.startsWith("test/") && info.hasMinitest)) {
    return `${runPrefix}rake test`;
  }
  return rubyProjectTestCommand(runPrefix, info, [path]);
}

function standaloneTestSuites(
  testFiles: string[],
  commandForTest: (path: string) => string | null,
): FeatureSeed[] {
  const groups = new Map<string, string[]>();
  for (const path of testFiles) {
    const root = path.startsWith("spec/")
      ? "spec"
      : path.startsWith("test/")
        ? "test"
        : path.includes("/")
          ? dirname(path)
          : "root";
    groups.set(root, [...(groups.get(root) ?? []), path]);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .flatMap(([label, files]) =>
      label === "root"
        ? chunkFiles(label, files.toSorted(), sourceGroupMaxOwnedFiles)
        : partitionSourceFiles(label, files, sourceGroupMaxOwnedFiles),
    )
    .map((group) => ({
      title: `Ruby test suite ${group.label}`,
      summary: `Ruby test files in ${group.label}.`,
      kind: "test-suite",
      source: "ruby-test-suite",
      confidence: "medium",
      entryPath: group.label,
      symbol: group.label,
      route: null,
      command: null,
      ownedFiles: group.files.map((path) => ({ path, reason: "ruby test file" })),
      contextFiles: [],
      tests: group.files.map((path) => ({ path, command: commandForTest(path) })),
      tags: ["ruby", "test"],
      trustBoundaries: [],
      testCommand: group.files.length > 0 ? commandForTest(group.files[0] ?? "") : null,
      skipNearbyTests: true,
    }));
}

function partitionSourceFiles(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
): SourceGroup[] {
  return partitionAt(sourceRoot, files.toSorted(), maxFiles, 0);
}

function partitionAt(
  sourceRoot: string,
  files: string[],
  maxFiles: number,
  depth: number,
): SourceGroup[] {
  if (files.length === 0) {
    return [];
  }
  if (files.length <= maxFiles) {
    return [{ label: commonLabel(sourceRoot, files, depth), files }];
  }
  const directFiles: string[] = [];
  const buckets = new Map<string, string[]>();
  for (const file of files) {
    const relativePath = file.slice(sourceRoot.length + 1);
    const parts = relativePath.split("/");
    if (parts.length <= depth + 1) {
      directFiles.push(file);
      continue;
    }
    const segment = parts[depth];
    if (segment === undefined) {
      directFiles.push(file);
      continue;
    }
    buckets.set(segment, [...(buckets.get(segment) ?? []), file]);
  }
  const groups = chunkFiles(currentLabel(sourceRoot, files, depth), directFiles, maxFiles);
  for (const [segment, bucketFiles] of [...buckets.entries()].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (bucketFiles.length <= maxFiles) {
      groups.push({
        label: `${sourceRoot}/${bucketPrefix(bucketFiles, sourceRoot, depth, segment)}`,
        files: bucketFiles,
      });
    } else {
      groups.push(...partitionAt(sourceRoot, bucketFiles, maxFiles, depth + 1));
    }
  }
  return groups;
}

function chunkFiles(label: string, files: string[], maxFiles: number): SourceGroup[] {
  const groups: SourceGroup[] = [];
  for (let index = 0; index < files.length; index += maxFiles) {
    const part = Math.floor(index / maxFiles) + 1;
    groups.push({
      label: files.length <= maxFiles ? label : `${label}#${part}`,
      files: files.slice(index, index + maxFiles),
    });
  }
  return groups;
}

function currentLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    return sourceRoot;
  }
  const first = files[0];
  if (first === undefined) {
    return sourceRoot;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return parts.length === 0 ? sourceRoot : `${sourceRoot}/${parts.join("/")}`;
}

function commonLabel(sourceRoot: string, files: string[], depth: number): string {
  if (depth === 0) {
    const first = files[0];
    return files.length === 1 && first !== undefined && !first.startsWith(`${sourceRoot}/`)
      ? first
      : sourceRoot;
  }
  if (files.length === 1) {
    return files[0] ?? sourceRoot;
  }
  return currentLabel(sourceRoot, files, depth);
}

function bucketPrefix(files: string[], sourceRoot: string, depth: number, segment: string): string {
  const first = files[0];
  if (first === undefined || depth === 0) {
    return segment;
  }
  const parts = first
    .slice(sourceRoot.length + 1)
    .split("/")
    .slice(0, depth);
  return [...parts, segment].join("/");
}

function associatedTests(
  files: string[],
  tests: string[],
  commandForTest: (path: string) => string | null,
): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.rb$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = rubyTestStem(test);
      return [...dirs].some((dir) => pathMatchesPrefix(test, dir)) || fileStems.has(testStem);
    })
    .slice(0, sourceGroupMaxTests)
    .map((path) => ({ path, command: commandForTest(path) }));
}

function rubyTestStem(path: string): string {
  const name = basename(path);
  if (name.endsWith("_spec.rb")) {
    return name.replace(/_spec\.rb$/u, "");
  }
  if (name.endsWith("_test.rb")) {
    return name.replace(/_test\.rb$/u, "");
  }
  if (/^test_.+\.rb$/u.test(name)) {
    return name.replace(/^test_/u, "").replace(/\.rb$/u, "");
  }
  return name.replace(/\.rb$/u, "");
}

function isReviewableRubySourceFile(path: string): boolean {
  return (
    path.endsWith(".rb") &&
    !isRubyTestPath(path) &&
    !rubyShouldSkip(path) &&
    !isRubyFixturePath(path) &&
    !/(^|\/)[^/]*(?:generated|\.gen)\.rb$/iu.test(path)
  );
}

function isRubyTestPath(path: string): boolean {
  return path.endsWith(".rb") && (basename(path).endsWith("_spec.rb") || isRubyMinitestPath(path));
}

function isRubyMinitestPath(path: string): boolean {
  const name = basename(path);
  return (
    name.endsWith("_test.rb") ||
    (/^test_.+\.rb$/u.test(name) &&
      !isRubyTestHelper(name) &&
      (path === name || /(^|\/)test\//u.test(path)))
  );
}

function isRubyTestHelper(name: string): boolean {
  return /^test_helpers?\.rb$/u.test(name);
}

function isRubyFixturePath(path: string): boolean {
  return /(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path);
}

function rubyShouldSkip(path: string): boolean {
  return (
    shouldSkip(path) ||
    /(^|\/)(\.bundle|vendor\/bundle)(\/|$)/u.test(path) ||
    /^(?:tmp|log)(?:\/|$)/u.test(path)
  );
}

async function containsReviewableRubySource(root: string): Promise<boolean> {
  for (const sourceRoot of await rubySourceRoots(root)) {
    if (!(await isSafeDirectory(root, join(root, sourceRoot)))) {
      continue;
    }
    if ((await walk(root, [sourceRoot])).some(isReviewableRubySourceFile)) {
      return true;
    }
  }
  for (const sourceRoot of await rubyExecutableRoots(root)) {
    if (!(await isSafeDirectory(root, join(root, sourceRoot)))) {
      continue;
    }
    for (const path of await walk(root, [sourceRoot])) {
      if (
        isReviewableRubySourceFile(path) ||
        (isRubyShebangCandidate(path) && (await hasRubyShebang(root, path)))
      ) {
        return true;
      }
    }
  }
  return false;
}

function isRubyShebangCandidate(path: string): boolean {
  return !basename(path).includes(".");
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].toSorted();
}

function uniquePathsInOrder(paths: string[]): string[] {
  return [...new Set(paths)];
}
