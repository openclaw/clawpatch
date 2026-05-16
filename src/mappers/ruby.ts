import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathExists } from "../fs.js";
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

export async function rubySeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await isRubyProject(root))) {
    return [];
  }
  const info = await rubyProjectInfo(root);
  const projectFiles = await rubyMetadataFiles(root);
  const testFiles = await rubyTestFiles(root);
  const testCommand = await rubyTestCommand(root, info, testFiles);
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
    const tests = associatedTests([executable], testFiles, testCommand);
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
    const tests = associatedTests(group.files, testFiles, testCommand);
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

  for (const testSuite of standaloneTestSuites(testFiles, testCommand)) {
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
    (await containsReviewableRubySource(root))
  );
}

async function rubyProjectInfo(root: string): Promise<RubyProjectInfo> {
  const source = await rubyDependencySource(root);
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
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".gemspec"))
    .map((entry) => entry.name)
    .toSorted();
}

async function rubyDependencySource(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const path of [...metadataFiles, ...(await rubyGemspecs(root))]) {
    if (await pathExists(join(root, path))) {
      chunks.push(await readFile(join(root, path), "utf8"));
    }
  }
  return chunks.join("\n");
}

function rubyProjectName(source: string): string | null {
  return /^\s*(?:spec|s)\.name\s*=\s*["']([^"']+)["']/mu.exec(source)?.[1] ?? null;
}

function rubyDependencyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const line of source.split("\n")) {
    const match =
      /^\s*(?:gem|s\.add_dependency|s\.add_development_dependency|spec\.add_dependency|spec\.add_development_dependency)\s*\(?\s*["']([^"']+)["']/u.exec(
        line,
      );
    if (match?.[1] !== undefined) {
      names.add(match[1].toLowerCase());
    }
  }
  return names;
}

function rubyTrustBoundaries(name: string, dependencies: Set<string>): TrustBoundary[] {
  const boundaries = new Set<TrustBoundary>(packageTrustBoundaries(name));
  const text = `${name} ${[...dependencies].join(" ")}`;
  if (/\b(redis|sequel|pg|mysql|sqlite|activerecord)\b/iu.test(text)) {
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
  if (dbFiles.length > 0) {
    seeds.push({
      title: "Rails database schema and migrations",
      summary: `Rails database files with ${dbFiles.length} migration/schema file(s).`,
      kind: "service",
      source: "rails-database",
      confidence: "high",
      entryPath: dbFiles[0] ?? "db",
      symbol: null,
      route: null,
      command: null,
      ownedFiles: dbFiles.map((path) => ({ path, reason: "rails database file" })),
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
    "config/database.yml",
    "config/boot.rb",
  ]);
  for (const prefix of ["config/environments", "config/initializers", "config/locales"]) {
    if (!(await isSafeDirectory(root, join(root, prefix)))) {
      continue;
    }
    files.push(
      ...(await walk(root, [prefix])).filter(
        (path) => /\.(rb|ya?ml)$/u.test(path) && !rubyShouldSkip(path),
      ),
    );
  }
  return uniquePaths(files);
}

async function railsDatabaseFiles(root: string): Promise<string[]> {
  if (!(await isSafeDirectory(root, join(root, "db")))) {
    return [];
  }
  return (await walk(root, ["db"]))
    .filter((path) => /\.(rb|ya?ml)$/u.test(path) && !rubyShouldSkip(path))
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
  if (!(await isSafeDirectory(root, join(root, "app/assets")))) {
    return [];
  }
  const files = (await walk(root, ["app/assets"])).filter(
    (path) =>
      /\.(js|coffee|css|scss|sass)$/u.test(path) &&
      !rubyShouldSkip(path) &&
      !path.includes("/images/"),
  );
  return partitionSourceFiles("app/assets", files, jekyllContentMaxOwnedFiles);
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
    .filter((path) => !["README.md", "Gemfile.lock"].includes(path))
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
  for (const executableRoot of executableRoots) {
    if (!(await isSafeDirectory(root, join(root, executableRoot)))) {
      continue;
    }
    for (const path of await walk(root, [executableRoot])) {
      if (skipRailsBinstubs && executableRoot === "bin" && railsBinstubs.has(basename(path))) {
        continue;
      }
      if (!rubyShouldSkip(path) && (path.endsWith(".rb") || (await hasRubyShebang(root, path)))) {
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
  const head = (await readFile(join(root, path), "utf8").catch(() => "")).slice(0, 160);
  return /^#!.*\bruby\b/u.test(head);
}

async function rubySourceGroups(root: string): Promise<SourceGroup[]> {
  const groups: SourceGroup[] = [];
  for (const sourceRoot of sourceRoots) {
    if (!(await isSafeDirectory(root, join(root, sourceRoot)))) {
      continue;
    }
    const files = (await walk(root, [sourceRoot])).filter(isReviewableRubySourceFile);
    groups.push(...partitionSourceFiles(sourceRoot, files, sourceGroupMaxOwnedFiles));
  }
  return groups;
}

async function rubyTestFiles(root: string): Promise<string[]> {
  const files = (await walk(root, ["spec", "test", ...sourceRoots]))
    .filter(isRubyTestPath)
    .filter((path) => !rubyShouldSkip(path) && !isRubyFixturePath(path));
  return uniquePaths(files).slice(0, 200);
}

async function rubyTestCommand(
  root: string,
  info: RubyProjectInfo,
  testFiles: string[],
): Promise<string | null> {
  const run = (await pathExists(join(root, "Gemfile"))) ? "bundle exec " : "";
  if (info.hasRspec || testFiles.some((path) => path.endsWith("_spec.rb"))) {
    return `${run}rspec`;
  }
  if (info.hasMinitest || testFiles.some((path) => path.endsWith("_test.rb"))) {
    return `${run}rake test`;
  }
  return null;
}

function standaloneTestSuites(testFiles: string[], command: string | null): FeatureSeed[] {
  const groups = new Map<string, string[]>();
  for (const path of testFiles) {
    const root = path.startsWith("spec/")
      ? "spec"
      : path.startsWith("test/")
        ? "test"
        : dirname(path);
    groups.set(root, [...(groups.get(root) ?? []), path]);
  }
  return [...groups.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([label, files]) => ({
      title: `Ruby test suite ${label}`,
      summary: `Ruby test files in ${label}.`,
      kind: "test-suite",
      source: "ruby-test-suite",
      confidence: "medium",
      entryPath: label,
      symbol: label,
      route: null,
      command: null,
      ownedFiles: files.map((path) => ({ path, reason: "ruby test file" })),
      contextFiles: [],
      tests: files.map((path) => ({ path, command })),
      tags: ["ruby", "test"],
      trustBoundaries: [],
      testCommand: command,
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

function associatedTests(files: string[], tests: string[], command: string | null): SeedTestRef[] {
  const fileStems = new Set(files.map((file) => basename(file).replace(/\.rb$/u, "")));
  const dirs = new Set(files.map((file) => dirname(file)));
  return tests
    .filter((test) => {
      const testStem = basename(test)
        .replace(/_spec\.rb$/u, "")
        .replace(/_test\.rb$/u, "")
        .replace(/\.rb$/u, "");
      return [...dirs].some((dir) => pathMatchesPrefix(test, dir)) || fileStems.has(testStem);
    })
    .slice(0, sourceGroupMaxTests)
    .map((path) => ({ path, command }));
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
  const name = basename(path);
  return path.endsWith(".rb") && (name.endsWith("_spec.rb") || name.endsWith("_test.rb"));
}

function isRubyFixturePath(path: string): boolean {
  return /(^|\/)(__fixtures__|fixtures|testdata)(\/|$)/u.test(path);
}

function rubyShouldSkip(path: string): boolean {
  return shouldSkip(path) || /(^|\/)(\.bundle|vendor\/bundle|tmp|log)(\/|$)/u.test(path);
}

async function containsReviewableRubySource(root: string): Promise<boolean> {
  for (const sourceRoot of [...sourceRoots, ...executableRoots]) {
    if (!(await isSafeDirectory(root, join(root, sourceRoot)))) {
      continue;
    }
    if ((await walk(root, [sourceRoot])).some(isReviewableRubySourceFile)) {
      return true;
    }
  }
  return false;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)].toSorted();
}
