import { lstat, readFile, readdir } from "node:fs/promises";
import { join, posix } from "node:path";
import { pathExists } from "./fs.js";
import { projectNameFromRoot, discoverGit } from "./git.js";
import { stableId } from "./id.js";
import {
  fileHasRubyShebang,
  rubyDependencyNames,
  rubyGemspecPaths,
  stripRubyComments,
} from "./ruby.js";
import { shellQuotePath } from "./shell.js";
import { ProjectRecord, ProjectCommands } from "./types.js";

type PackageJson = {
  name?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  bin?: unknown;
};

export type ComposerJson = {
  name?: unknown;
  type?: unknown;
  scripts?: unknown;
  require?: unknown;
  "require-dev"?: unknown;
};

type PythonProjectInfo = {
  dependencies: Set<string>;
  tools: Set<string>;
  hasPytestConfig: boolean;
};

type MixProjectInfo = {
  dependencies: Set<string>;
};

export async function detectProject(root: string): Promise<ProjectRecord> {
  const git = await discoverGit(root);
  const pkg = await readPackageJson(root);
  const composer = await readComposerJson(root);
  const packageManagers = await detectPackageManagers(root);
  const frameworks = await detectFrameworks(root, pkg, composer);
  const languages = await detectLanguages(root);
  const commands = await detectCommands(root, pkg, composer, languages, packageManagers);
  const name =
    typeof pkg?.name === "string"
      ? pkg.name
      : typeof composer?.name === "string"
        ? (composer.name.split("/").at(-1) ?? composer.name)
        : projectNameFromRoot(root, git.remoteUrl);
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    projectId: stableId("prj", [git.remoteUrl ?? root, name]),
    name,
    rootPath: root,
    git: {
      remoteUrl: git.remoteUrl,
      defaultBranch: git.defaultBranch,
      currentBranch: git.currentBranch,
      headSha: git.headSha,
    },
    detected: {
      languages,
      frameworks,
      packageManagers,
      commands,
    },
    createdAt: now,
    updatedAt: now,
  };
}

export async function readPackageJson(root: string): Promise<PackageJson | null> {
  const path = join(root, "package.json");
  if (!(await pathExists(path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as PackageJson) : null;
}

export function packageScripts(pkg: PackageJson | null): Record<string, string> {
  if (typeof pkg?.scripts !== "object" || pkg.scripts === null) {
    return {};
  }
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string") {
      scripts[key] = value;
    }
  }
  return scripts;
}

export function packageBins(pkg: PackageJson | null): Record<string, string> {
  const bin = pkg?.bin;
  if (typeof bin === "string") {
    const name = typeof pkg?.name === "string" ? pkg.name : "bin";
    return { [name]: bin };
  }
  if (typeof bin !== "object" || bin === null) {
    return {};
  }
  const bins: Record<string, string> = {};
  for (const [key, value] of Object.entries(bin)) {
    if (typeof value === "string") {
      bins[key] = value;
    }
  }
  return bins;
}

export async function readComposerJson(root: string): Promise<ComposerJson | null> {
  const path = join(root, "composer.json");
  if (!(await pathExists(path))) {
    return null;
  }
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return typeof parsed === "object" && parsed !== null ? (parsed as ComposerJson) : null;
}

export function composerScripts(composer: ComposerJson | null): Record<string, string> {
  if (typeof composer?.scripts !== "object" || composer.scripts === null) {
    return {};
  }
  const scripts: Record<string, string> = {};
  for (const [key, value] of Object.entries(composer.scripts)) {
    if (typeof value === "string") {
      scripts[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      scripts[key] = value.join(" && ");
    }
  }
  return scripts;
}

export function composerDependencyNames(composer: ComposerJson | null): Set<string> {
  const names = new Set<string>();
  for (const field of [composer?.require, composer?.["require-dev"]]) {
    if (typeof field !== "object" || field === null) {
      continue;
    }
    for (const name of Object.keys(field)) {
      names.add(name);
    }
  }
  return names;
}

async function detectCommands(
  root: string,
  pkg: PackageJson | null,
  composer: ComposerJson | null,
  languages: string[],
  packageManagers: string[],
): Promise<ProjectCommands> {
  const scripts = packageScripts(pkg);
  const composerScriptMap = composerScripts(composer);
  const defaults = await languageDefaultCommands(root, languages, composer);
  const packageManager = packageScriptManager(packageManagers);
  const composerTestCommand = composerValidationCommand(composerScriptMap, ["test"]);
  return {
    typecheck:
      scripts["typecheck"] !== undefined
        ? packageRunCommand(packageManager, "typecheck")
        : (composerValidationCommand(composerScriptMap, ["typecheck", "analyse", "analyze"]) ??
          defaults.typecheck),
    lint:
      scripts["lint"] !== undefined
        ? packageRunCommand(packageManager, "lint")
        : (composerValidationCommand(composerScriptMap, ["lint"]) ?? defaults.lint),
    format:
      scripts["format"] !== undefined
        ? packageRunCommand(packageManager, "format")
        : (composerValidationCommand(composerScriptMap, ["format"]) ?? defaults.format),
    test:
      scripts["test"] !== undefined
        ? packageRunCommand(packageManager, "test")
        : (composerTestCommand ?? defaults.test),
  };
}

function composerValidationCommand(
  scripts: Record<string, string>,
  candidates: string[],
): string | null {
  const script = candidates.find((candidate) => scripts[candidate] !== undefined);
  return script === undefined ? null : `composer ${script}`;
}

async function languageDefaultCommands(
  root: string,
  languages: string[],
  composer: ComposerJson | null,
): Promise<ProjectCommands> {
  if (languages.includes("go")) {
    return {
      typecheck: "go test ./...",
      lint: null,
      format: null,
      test: "go test ./...",
    };
  }
  if (languages.includes("rust")) {
    return {
      typecheck: "cargo check --workspace --all-targets",
      lint: null,
      format: "cargo fmt --all --check",
      test: "cargo test --workspace",
    };
  }
  if (languages.includes("swift") && (await pathExists(join(root, "Package.swift")))) {
    return {
      typecheck: "swift build",
      lint: null,
      format: null,
      test: (await hasSwiftTests(root)) ? "swift test" : null,
    };
  }
  if (languages.includes("python")) {
    return pythonDefaultCommands(root);
  }
  if (languages.includes("php")) {
    return phpDefaultCommands(root, composer);
  }
  if (
    (languages.includes("java") || languages.includes("kotlin")) &&
    (await isRootGradleProject(root))
  ) {
    return gradleDefaultCommands(root);
  }
  if (await isRootMavenProject(root)) {
    return mavenDefaultCommands(root);
  }
  if (languages.includes("elixir")) {
    return elixirDefaultCommands(root);
  }
  if (languages.some((language) => dotnetLanguages.has(language))) {
    const dotnetCommands = await dotnetDefaultCommands(root);
    if (hasValidationCommand(dotnetCommands)) {
      return dotnetCommands;
    }
  }
  if (languages.includes("ruby")) {
    return rubyDefaultCommands(root);
  }

  return {
    typecheck: null,
    lint: null,
    format: null,
    test: null,
  };
}

function hasValidationCommand(commands: ProjectCommands): boolean {
  return (
    commands.typecheck !== null ||
    commands.lint !== null ||
    commands.format !== null ||
    commands.test !== null
  );
}

function packageScriptManager(packageManagers: string[]): string {
  return packageManagers.find((name) => nodePackageManagers.has(name)) ?? "npm";
}

const nodePackageManagers = new Set(["pnpm", "npm", "yarn", "bun", "node"]);

function packageRunCommand(packageManager: string, script: string): string {
  if (packageManager === "pnpm") {
    return `pnpm ${script}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${script}`;
  }
  if (packageManager === "bun") {
    return `bun run ${script}`;
  }
  return `npm run ${script}`;
}

async function detectPackageManagers(root: string): Promise<string[]> {
  const found: string[] = [];
  const nodeChecks: Array<[string, string]> = [
    ["pnpm", "pnpm-lock.yaml"],
    ["npm", "package-lock.json"],
    ["yarn", "yarn.lock"],
    ["bun", "bun.lock"],
    ["bun", "bun.lockb"],
  ];
  for (const [name, file] of nodeChecks) {
    if ((await pathExists(join(root, file))) && !found.includes(name)) {
      found.push(name);
    }
  }
  if ((await pathExists(join(root, "pnpm-workspace.yaml"))) && !found.includes("pnpm")) {
    found.push("pnpm");
  }
  if (
    !found.some((name) => nodePackageManagers.has(name)) &&
    (await pathExists(join(root, "package.json")))
  ) {
    found.push("node");
  }

  const nativeChecks: Array<[string, string]> = [
    ["cargo", "Cargo.toml"],
    ["swiftpm", "Package.swift"],
  ];
  for (const [name, file] of nativeChecks) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  if (await pathExists(join(root, "mix.exs"))) {
    found.push("mix");
  }
  if (!found.includes("swiftpm") && (await containsFileNamed(root, "Package.swift", 5))) {
    found.push("swiftpm");
  }
  if (
    !found.includes("gradle") &&
    ((await containsFileNamed(root, "settings.gradle", 5)) ||
      (await containsFileNamed(root, "settings.gradle.kts", 5)) ||
      (await containsFileNamed(root, "build.gradle", 5)) ||
      (await containsFileNamed(root, "build.gradle.kts", 5)))
  ) {
    found.push("gradle");
  }
  if (!found.includes("maven") && (await containsFileNamed(root, "pom.xml", 5))) {
    found.push("maven");
  }
  if (
    !found.includes("cmake") &&
    (await containsFileNamed(root, "CMakeLists.txt", 5, shouldSkipCOrCppSearchEntry))
  ) {
    found.push("cmake");
  }
  if (
    !found.includes("autotools") &&
    ((await containsFileNamed(root, "Makefile.am", 5, shouldSkipCOrCppSearchEntry)) ||
      (await containsFileNamed(root, "Makefile.in", 5, shouldSkipCOrCppSearchEntry)))
  ) {
    found.push("autotools");
  }
  if (!found.includes("dotnet") && (await hasDotnetBuildManifest(root))) {
    found.push("dotnet");
  }
  if (await pathExists(join(root, "composer.json"))) {
    found.push("composer");
  }
  const pythonManagers: Array<[string, string]> = [
    ["uv", "uv.lock"],
    ["poetry", "poetry.lock"],
    ["pdm", "pdm.lock"],
    ["hatch", "hatch.toml"],
  ];
  for (const [name, file] of pythonManagers) {
    if (await pathExists(join(root, file))) {
      found.push(name);
    }
  }
  for (const tool of ["uv", "poetry", "pdm", "hatch"]) {
    if (!found.includes(tool) && (await pyprojectHasToolSection(root, tool))) {
      found.push(tool);
    }
  }
  if (!found.some((name) => pythonPackageManagers.has(name)) && (await isPythonProject(root))) {
    found.push((await pathExists(join(root, "requirements.txt"))) ? "pip" : "python");
  }
  if ((await isRubyProject(root)) && !found.some((name) => rubyPackageManagers.has(name))) {
    found.push((await hasBundlerConfig(root)) ? "bundler" : "ruby");
  }
  return found;
}

const pythonPackageManagers = new Set(["uv", "poetry", "pdm", "hatch", "pip", "python"]);
const rubyPackageManagers = new Set(["bundler", "ruby"]);
const dotnetLanguages = new Set(["csharp", "fsharp", "visual-basic"]);

async function elixirDefaultCommands(root: string): Promise<ProjectCommands> {
  const info = await mixProjectInfo(root);
  return {
    typecheck: "mix compile --warnings-as-errors",
    lint: info.dependencies.has("credo") ? "mix credo --strict" : null,
    format: "mix format --check-formatted",
    test: "mix test",
  };
}

async function isRootGradleProject(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "settings.gradle"))) ||
    (await pathExists(join(root, "settings.gradle.kts"))) ||
    (await pathExists(join(root, "build.gradle"))) ||
    (await pathExists(join(root, "build.gradle.kts")))
  );
}

async function gradleDefaultCommands(root: string): Promise<ProjectCommands> {
  const runner = (await pathExists(join(root, "gradlew"))) ? "./gradlew" : "gradle";
  return {
    typecheck: `${runner} build`,
    lint: null,
    format: null,
    test: `${runner} test`,
  };
}

async function isRootMavenProject(root: string): Promise<boolean> {
  return await pathExists(join(root, "pom.xml"));
}

async function mavenDefaultCommands(root: string): Promise<ProjectCommands> {
  const runner = (await pathExists(join(root, "mvnw"))) ? "./mvnw" : "mvn";
  return {
    typecheck: `${runner} -DskipTests compile`,
    lint: null,
    format: null,
    test: `${runner} test`,
  };
}

async function dotnetDefaultCommands(root: string): Promise<ProjectCommands> {
  const target = await dotnetValidationTarget(root);
  const testTarget = await dotnetTestTarget(root, target);
  return {
    typecheck: target === null ? null : `dotnet build ${shellQuotePath(target)}`,
    lint: null,
    format: null,
    test: testTarget === null ? null : `dotnet test ${shellQuotePath(testTarget)}`,
  };
}

async function dotnetValidationTarget(root: string): Promise<string | null> {
  const solutions = (await collectDotnetFiles(root, isDotnetSolutionFileName, 4)).toSorted();
  const rootSolutions = solutions.filter((path) => !path.includes("/"));
  const projects = (await collectDotnetFiles(root, isDotnetProjectFileName, 5)).toSorted();
  const solutionCoverageProjects = await dotnetSolutionCoverageProjects(root, projects);
  if (rootSolutions.length === 1) {
    const solution = rootSolutions[0] ?? null;
    if (
      solution !== null &&
      (await dotnetSolutionIncludesProjects(root, solution, solutionCoverageProjects, projects))
    ) {
      return solution;
    }
  }

  const rootProjects = projects.filter((path) => !path.includes("/"));
  if (rootProjects.length === 1) {
    return rootProjects[0] ?? null;
  }
  if (
    rootSolutions.length === 0 &&
    solutions.length === 1 &&
    (await dotnetSolutionIncludesProjects(
      root,
      solutions[0] ?? "",
      solutionCoverageProjects,
      projects,
    ))
  ) {
    return solutions[0] ?? null;
  }
  return projects.length === 1 ? (projects[0] ?? null) : null;
}

async function dotnetSolutionCoverageProjects(root: string, projects: string[]): Promise<string[]> {
  const buildProjects: string[] = [];
  for (const project of projects) {
    const source = await readFile(join(root, project), "utf8").catch(() => "");
    if (!isStrongDotnetTestProject(source)) {
      buildProjects.push(project);
    }
  }
  return buildProjects.length === 0 ? projects : buildProjects;
}

async function dotnetTestTarget(root: string, buildTarget: string | null): Promise<string | null> {
  const projects = await collectDotnetFiles(root, isDotnetProjectFileName, 5);
  const testProjects: string[] = [];
  for (const project of projects) {
    const source = await readFile(join(root, project), "utf8").catch(() => "");
    if (isStrongDotnetTestProject(source)) {
      testProjects.push(project);
    }
  }
  if (testProjects.length === 0) {
    return null;
  }
  if (
    buildTarget !== null &&
    (testProjects.includes(buildTarget) ||
      (isDotnetSolutionFileName(buildTarget) &&
        (await dotnetSolutionIncludesProjects(root, buildTarget, testProjects, projects))))
  ) {
    return buildTarget;
  }
  return testProjects.length === 1 ? (testProjects[0] ?? null) : null;
}

async function dotnetSolutionIncludesProjects(
  root: string,
  solution: string,
  projects: string[],
  knownProjects: string[],
): Promise<boolean> {
  const source = await readFile(join(root, solution), "utf8").catch(() => "");
  const solutionProjects = dotnetSolutionProjectPaths(solution, source);
  if (solutionProjects.invalid) {
    return false;
  }
  const knownProjectSet = new Set(knownProjects);
  const solutionProjectSet = new Set(solutionProjects.paths);
  return (
    solutionProjects.paths.every((project) => knownProjectSet.has(project)) &&
    projects.every((project) => solutionProjectSet.has(project))
  );
}

function dotnetSolutionProjectPaths(
  solution: string,
  source: string,
): {
  paths: string[];
  invalid: boolean;
} {
  const solutionRoot = solution.includes("/") ? solution.slice(0, solution.lastIndexOf("/")) : ".";
  const paths: string[] = [];
  let invalid = false;
  const activeSource = isDotnetSlnxFileName(solution) ? stripXmlComments(source) : source;
  const pattern = isDotnetSlnxFileName(solution)
    ? /\bPath\s*=\s*["']([^"']+\.(?:cs|fs|vb)proj)["']/gimu
    : /^Project\([^)]+\)\s*=\s*"[^"]*"\s*,\s*"([^"]+\.(?:cs|fs|vb)proj)"/gimu;
  for (const match of activeSource.matchAll(pattern)) {
    const path = dotnetSolutionProjectPath(solutionRoot, match[1] ?? "");
    if (path !== null) {
      paths.push(path);
    } else {
      invalid = true;
    }
  }
  return { paths: [...new Set(paths)], invalid };
}

function dotnetSolutionProjectPath(solutionRoot: string, path: string): string | null {
  const normalized = path.replace(/\\/gu, "/");
  if (normalized.length === 0 || /^(?:[A-Za-z]:)?\//u.test(normalized)) {
    return null;
  }
  const resolved = posix.normalize(
    [solutionRoot === "." ? "" : solutionRoot, normalized].filter(Boolean).join("/"),
  );
  if (resolved === "." || resolved === ".." || resolved.startsWith("../")) {
    return null;
  }
  return resolved;
}

async function phpDefaultCommands(
  root: string,
  composer: ComposerJson | null,
): Promise<ProjectCommands> {
  const dependencies = composerDependencyNames(composer);
  const hasArtisan = await pathExists(join(root, "artisan"));
  const hasPint = dependencies.has("laravel/pint");
  const hasPhpStan = dependencies.has("phpstan/phpstan") || dependencies.has("larastan/larastan");
  const hasPest = dependencies.has("pestphp/pest");
  const hasPhpunit =
    dependencies.has("phpunit/phpunit") ||
    dependencies.has("phpunit/phpunit-selenium") ||
    (await pathExists(join(root, "phpunit.xml"))) ||
    (await pathExists(join(root, "phpunit.xml.dist")));
  return {
    typecheck: hasPhpStan ? "vendor/bin/phpstan analyse" : null,
    lint: hasPint ? "vendor/bin/pint --test" : null,
    format: hasPint ? "vendor/bin/pint --test" : null,
    test: hasArtisan
      ? "php artisan test"
      : hasPest
        ? "vendor/bin/pest"
        : hasPhpunit
          ? "vendor/bin/phpunit"
          : null,
  };
}

async function pythonDefaultCommands(root: string): Promise<ProjectCommands> {
  const info = await pythonProjectInfo(root);
  const runner = await pythonRunner(root);
  const hasPytest =
    info.hasPytestConfig ||
    info.dependencies.has("pytest") ||
    (await containsPythonTestFile(root, 5));
  const hasRuff = info.tools.has("ruff") || info.dependencies.has("ruff");
  const hasBlack = info.tools.has("black") || info.dependencies.has("black");
  const hasPyright = info.tools.has("pyright") || info.dependencies.has("pyright");
  const hasMypy = info.tools.has("mypy") || info.dependencies.has("mypy");
  return {
    typecheck: hasPyright
      ? pythonRunCommand(runner, "pyright")
      : hasMypy
        ? pythonRunCommand(runner, "mypy .")
        : hasRuff
          ? pythonRunCommand(runner, "ruff check .")
          : null,
    lint: hasRuff ? pythonRunCommand(runner, "ruff check .") : null,
    format: hasRuff
      ? pythonRunCommand(runner, "ruff format --check .")
      : hasBlack
        ? pythonRunCommand(runner, "black --check .")
        : null,
    test: hasPytest ? pythonRunCommand(runner, "pytest") : null,
  };
}

async function pythonRunner(root: string): Promise<string | null> {
  if ((await pathExists(join(root, "uv.lock"))) || (await pyprojectHasToolSection(root, "uv"))) {
    return "uv";
  }
  if (
    (await pathExists(join(root, "poetry.lock"))) ||
    (await pyprojectHasToolSection(root, "poetry"))
  ) {
    return "poetry";
  }
  if ((await pathExists(join(root, "pdm.lock"))) || (await pyprojectHasToolSection(root, "pdm"))) {
    return "pdm";
  }
  if (
    (await pathExists(join(root, "hatch.toml"))) ||
    (await pyprojectHasToolSection(root, "hatch"))
  ) {
    return "hatch";
  }
  return null;
}

async function pyprojectHasToolSection(root: string, tool: string): Promise<boolean> {
  if (!(await pathExists(join(root, "pyproject.toml")))) {
    return false;
  }
  const source = await readFile(join(root, "pyproject.toml"), "utf8");
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*\\[\\[?tool\\.${escaped}(?:\\.|\\])`, "mu").test(source);
}

function pythonRunCommand(runner: string | null, command: string): string {
  if (runner === "uv") {
    return `uv run ${command}`;
  }
  if (runner === "poetry") {
    return `poetry run ${command}`;
  }
  if (runner === "pdm") {
    return `pdm run ${command}`;
  }
  if (runner === "hatch") {
    return `hatch run ${command}`;
  }
  return command;
}

async function rubyDefaultCommands(root: string): Promise<ProjectCommands> {
  const source = await rubyDependencySource(root);
  const dependencies = rubyDependencyNames(source);
  const hasBundle = await hasBundlerConfig(root);
  const hasRspec =
    dependencies.has("rspec") ||
    dependencies.has("rspec-rails") ||
    (await containsRubySpecFile(root, 5));
  const hasMinitest = dependencies.has("minitest") || (await containsRubyTestFile(root, 5));
  const hasRubocop =
    hasRubocopDependency(dependencies) ||
    (await pathExists(join(root, ".rubocop.yml"))) ||
    (await pathExists(join(root, ".rubocop_todo.yml")));
  const run = hasBundle ? "bundle exec " : "";
  return {
    typecheck: null,
    lint: hasRubocop ? `${run}rubocop` : null,
    format: null,
    test: hasRspec ? `${run}rspec` : hasMinitest ? `${run}rake test` : null,
  };
}

async function mixProjectInfo(root: string): Promise<MixProjectInfo> {
  if (!(await pathExists(join(root, "mix.exs")))) {
    return { dependencies: new Set() };
  }
  const source = stripLineComments(await readFile(join(root, "mix.exs"), "utf8"), "#");
  return { dependencies: mixDependencyNames(source) };
}

function mixDependencyNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/\{:\s*([a-zA-Z][a-zA-Z0-9_]*)\s*,/gu)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return names;
}

function hasRubocopDependency(dependencies: Set<string>): boolean {
  return [...dependencies].some(
    (dependency) => dependency === "rubocop" || dependency.startsWith("rubocop-"),
  );
}

async function hasBundlerConfig(root: string): Promise<boolean> {
  return (await pathExists(join(root, "Gemfile"))) || (await pathExists(join(root, "gems.rb")));
}

async function rubyDependencySource(root: string): Promise<string> {
  const chunks: string[] = [];
  for (const path of ["Gemfile", "gems.rb"]) {
    if (await pathExists(join(root, path))) {
      chunks.push(await readFile(join(root, path), "utf8"));
    }
  }
  for (const path of await rubyGemspecPaths(root)) {
    chunks.push(await readFile(join(root, path), "utf8"));
  }
  return stripRubyComments(chunks.join("\n"));
}

async function pythonProjectInfo(root: string): Promise<PythonProjectInfo> {
  const info: PythonProjectInfo = {
    dependencies: new Set(),
    tools: new Set(),
    hasPytestConfig: false,
  };
  if (await pathExists(join(root, "pyproject.toml"))) {
    const pyproject = await readFile(join(root, "pyproject.toml"), "utf8");
    for (const dependency of pythonDependencyNames(pyproject)) {
      info.dependencies.add(dependency);
    }
    for (const tool of pythonToolSections(pyproject)) {
      info.tools.add(tool);
    }
    info.hasPytestConfig = info.tools.has("pytest") || info.tools.has("pytest.ini_options");
  }
  if (await pathExists(join(root, "requirements.txt"))) {
    const source = await readFile(join(root, "requirements.txt"), "utf8");
    for (const dependency of pythonRequirementNames(source)) {
      info.dependencies.add(dependency);
    }
  }
  if (await pathExists(join(root, "setup.cfg"))) {
    const source = await readFile(join(root, "setup.cfg"), "utf8");
    for (const dependency of pythonSetupCfgRequirementNames(source)) {
      info.dependencies.add(dependency);
    }
    if (/^\s*(?:\[tool:pytest\]|\[pytest\])\s*(?:#.*)?$/mu.test(source)) {
      info.hasPytestConfig = true;
    }
    for (const toolMatch of source.matchAll(/^\s*\[(mypy|pyright|ruff|black)\]/gmu)) {
      if (toolMatch[1] !== undefined) {
        info.tools.add(toolMatch[1]);
      }
    }
  }
  return info;
}

function pythonDependencyNames(source: string): string[] {
  const names = new Set<string>();
  for (const table of [
    pythonTomlTable(source, "project"),
    pythonTomlTable(source, "tool.uv"),
    pythonTomlTable(source, "tool.poetry"),
    pythonTomlTable(source, "tool.poetry.group.dev"),
    pythonTomlTable(source, "tool.pdm.dev-dependencies"),
    ...pythonTomlTablesMatching(source, /^tool\.hatch\.envs\.[^.]+$/u),
  ]) {
    for (const section of pythonTomlArraySections(table, ["dependencies", "dev-dependencies"])) {
      for (const value of pythonTomlArrayValues(section)) {
        const name = pythonRequirementName(value);
        if (name !== null) {
          names.add(name);
        }
      }
    }
  }
  for (const table of pythonTomlTables(source, [
    "tool.poetry.dependencies",
    "tool.poetry.dev-dependencies",
  ]).concat(pythonTomlTablesMatching(source, /^tool\.poetry\.group\.[^.]+\.dependencies$/u))) {
    for (const value of pythonTomlAssignedKeysAndValues(table)) {
      const name = pythonRequirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  for (const table of pythonTomlTables(source, [
    "project.optional-dependencies",
    "dependency-groups",
    "tool.pdm.dev-dependencies",
  ])) {
    for (const value of pythonTomlAssignedValues(table)) {
      const name = pythonRequirementName(value);
      if (name !== null) {
        names.add(name);
      }
    }
  }
  return [...names];
}

function pythonTomlTable(source: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "mu").exec(source);
  if (match?.index === undefined) {
    return "";
  }
  const rest = source.slice(match.index + match[0].length);
  const next = pythonTomlHeaderPattern.exec(rest);
  return next?.index === undefined ? rest : rest.slice(0, next.index);
}

function pythonToolSections(source: string): string[] {
  const tools = new Set<string>();
  for (const match of source.matchAll(
    /^\s*\[\[?tool\.([A-Za-z0-9_.-]+)[^\]]*\]\]?\s*(?:#.*)?$/gmu,
  )) {
    const name = match[1]?.split(".")[0];
    if (name !== undefined) {
      tools.add(name);
    }
  }
  return [...tools];
}

function pythonTomlArraySections(source: string, keys: string[]): string[] {
  const sections: string[] = [];
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const match of source.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*\\[`, "gmu"))) {
      sections.push(readTomlBracketValue(source, match.index + match[0].lastIndexOf("[")));
    }
  }
  return sections;
}

function pythonTomlTables(source: string, names: string[]): string[] {
  const tables: string[] = [];
  for (const name of names) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`^\\s*\\[${escaped}\\]\\s*(?:#.*)?$`, "gmu");
    for (const match of source.matchAll(pattern)) {
      const start = match.index + match[0].length;
      const rest = source.slice(start);
      const next = pythonTomlHeaderPattern.exec(rest);
      tables.push(next?.index === undefined ? rest : rest.slice(0, next.index));
    }
  }
  return tables;
}

function pythonTomlTablesMatching(source: string, pattern: RegExp): string[] {
  const tables: string[] = [];
  for (const match of source.matchAll(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/gmu)) {
    const name = match[1];
    if (name === undefined || !pattern.test(name)) {
      continue;
    }
    const start = match.index + match[0].length;
    const rest = source.slice(start);
    const next = pythonTomlHeaderPattern.exec(rest);
    tables.push(next?.index === undefined ? rest : rest.slice(0, next.index));
  }
  return tables;
}

const pythonTomlHeaderPattern = /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/mu;

function pythonTomlAssignedValues(source: string): string[] {
  const values: string[] = [];
  for (const match of source.matchAll(/^\s*["']?[^#"'=\s]+["']?\s*=\s*/gmu)) {
    if (match.index === undefined) {
      continue;
    }
    const valueStart = match.index + match[0].length;
    const lineEnd = source.indexOf("\n", valueStart);
    const rawValue = source.slice(valueStart, lineEnd === -1 ? source.length : lineEnd).trim();
    if (rawValue.startsWith("[")) {
      values.push(...pythonTomlArrayValues(readTomlBracketValue(source, valueStart)));
      continue;
    }
    values.push(...pythonTomlArrayValues(rawValue));
  }
  return values;
}

function pythonTomlAssignedKeysAndValues(source: string): string[] {
  const values = pythonTomlAssignedValues(source);
  for (const line of source.split("\n")) {
    const key = /^\s*["']?([^#"'=\s]+)["']?\s*=/u.exec(line)?.[1];
    if (key !== undefined) {
      values.push(key);
    }
  }
  return values;
}

function pythonTomlArrayValues(source: string): string[] {
  return pythonTomlStringValues(source);
}

function pythonTomlStringValues(source: string): string[] {
  const values: string[] = [];
  let quote: string | null = null;
  let value = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        values.push(value);
        quote = null;
        value = "";
      } else {
        value += char;
      }
      continue;
    }
    if (char === "#") {
      const nextNewline = source.indexOf("\n", index + 1);
      if (nextNewline === -1) {
        break;
      }
      index = nextNewline;
    } else if (char === '"' || char === "'") {
      quote = char;
      value = "";
    }
  }
  return values;
}

function readTomlBracketValue(source: string, bracketIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = bracketIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
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
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketIndex, index + 1);
      }
    }
  }
  return source.slice(bracketIndex);
}

function pythonRequirementNames(source: string): string[] {
  return source
    .split("\n")
    .map((line) => pythonRequirementName(line))
    .filter((name): name is string => name !== null);
}

function pythonSetupCfgRequirementNames(source: string): string[] {
  const names = new Set<string>();
  let section = "";
  let collecting = false;
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\r$/u, "");
    if (/^\s*(?:#|;|$)/u.test(line)) {
      continue;
    }
    const header = /^\s*\[([^\]]+)\]\s*$/u.exec(line);
    if (header?.[1] !== undefined) {
      section = header[1].toLowerCase();
      collecting = false;
      continue;
    }
    if (section !== "options" && section !== "options.extras_require") {
      continue;
    }
    const assignment = /^\s*([A-Za-z0-9_.-]+)\s*=\s*(.*)$/u.exec(line);
    if (assignment !== null) {
      const key = assignment[1]?.toLowerCase().replace(/-/gu, "_") ?? "";
      collecting =
        section === "options"
          ? ["install_requires", "setup_requires", "tests_require"].includes(key)
          : true;
      if (collecting && assignment[2] !== undefined) {
        addPythonRequirementNames(names, assignment[2]);
      }
      continue;
    }
    if (collecting && /^\s+/u.test(line)) {
      addPythonRequirementNames(names, line);
    }
  }
  return [...names];
}

function addPythonRequirementNames(names: Set<string>, value: string): void {
  for (const part of value.split(",")) {
    const name = pythonRequirementName(part);
    if (name !== null) {
      names.add(name);
    }
  }
}

function pythonRequirementName(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/gu, "");
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
    return null;
  }
  const match = /^([A-Za-z0-9_.-]+)/u.exec(trimmed);
  return match?.[1]?.toLowerCase().replace(/_/gu, "-") ?? null;
}

async function containsPythonTestFile(root: string, maxDepth: number): Promise<boolean> {
  return containsFileMatching(
    root,
    maxDepth,
    (entry) => /^test_.+\.py$/u.test(entry) || entry.endsWith("_test.py"),
  );
}

async function hasSwiftTests(root: string): Promise<boolean> {
  if (!(await pathExists(join(root, "Package.swift")))) {
    return false;
  }
  const manifest = stripSwiftComments(await readFile(join(root, "Package.swift"), "utf8"));
  if (/\.testTarget\s*\(/u.test(manifest)) {
    return true;
  }
  return containsSwiftFile(join(root, "Tests"));
}

async function containsSwiftFile(dir: string): Promise<boolean> {
  if (!(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) {
    return false;
  }
  const entries = await readdir(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && entry.endsWith(".swift")) {
      return true;
    }
    if (info.isDirectory() && (await containsSwiftFile(full))) {
      return true;
    }
  }
  return false;
}

async function detectFrameworks(
  root: string,
  pkg: PackageJson | null,
  composer: ComposerJson | null,
): Promise<string[]> {
  const deps = dependencyNames(pkg);
  const composerDeps = composerDependencyNames(composer);
  const frameworks: string[] = [];
  for (const name of ["next", "express", "fastify", "hono", "vitest"]) {
    if (deps.has(name)) {
      frameworks.push(name);
    }
  }
  if (composerDeps.has("laravel/framework")) {
    frameworks.push("laravel");
  }
  if (composerDeps.has("symfony/framework-bundle")) {
    frameworks.push("symfony");
  }
  if (composerDeps.has("slim/slim")) {
    frameworks.push("slim");
  }
  if (await isPythonProject(root)) {
    const info = await pythonProjectInfo(root);
    for (const name of ["flask", "fastapi", "django", "pytest"]) {
      if (info.dependencies.has(name)) {
        frameworks.push(name);
      }
    }
    for (const name of await pythonImportedFrameworks(root)) {
      if (!frameworks.includes(name)) {
        frameworks.push(name);
      }
    }
  }
  for (const name of await detectRubyFrameworks(root)) {
    if (!frameworks.includes(name)) {
      frameworks.push(name);
    }
  }
  for (const name of await detectElixirFrameworks(root)) {
    if (!frameworks.includes(name)) {
      frameworks.push(name);
    }
  }
  for (const name of await detectMavenFrameworks(root)) {
    if (!frameworks.includes(name)) {
      frameworks.push(name);
    }
  }
  for (const name of await detectDotnetFrameworks(root)) {
    if (!frameworks.includes(name)) {
      frameworks.push(name);
    }
  }
  return uniqueStrings(frameworks);
}

async function detectMavenFrameworks(root: string): Promise<string[]> {
  const frameworks: string[] = [];
  for (const pom of await collectMavenPomFiles(root, 5)) {
    const source = await readFile(join(root, pom), "utf8").catch(() => "");
    const activeSource = stripXmlComments(source);
    if (mavenPomHasSpring(activeSource)) {
      frameworks.push("spring");
    }
    if (mavenPomHasSpringBoot(activeSource)) {
      frameworks.push("spring-boot");
    }
  }
  return uniqueStrings(frameworks);
}

function mavenPomHasSpring(source: string): boolean {
  return /<groupId>\s*org\.springframework(?:\.[^<]*)?\s*<\/groupId>/iu.test(source);
}

function mavenPomHasSpringBoot(source: string): boolean {
  return (
    /<groupId>\s*org\.springframework\.boot\s*<\/groupId>/iu.test(source) ||
    /<artifactId>\s*spring-boot-[^<]*\s*<\/artifactId>/iu.test(source)
  );
}

async function detectDotnetFrameworks(root: string): Promise<string[]> {
  const frameworks: string[] = [];
  for (const project of await collectDotnetFiles(root, isDotnetProjectFileName, 5)) {
    const source = await readFile(join(root, project), "utf8").catch(() => "");
    const activeSource = stripXmlComments(source);
    if (isDotnetWebProject(activeSource)) {
      frameworks.push("aspnetcore");
    }
    if (hasDotnetTestFrameworkEvidence(activeSource)) {
      frameworks.push("dotnet-test");
    }
  }
  return uniqueStrings(frameworks);
}

async function detectElixirFrameworks(root: string): Promise<string[]> {
  if (!(await pathExists(join(root, "mix.exs")))) {
    return [];
  }
  const info = await mixProjectInfo(root);
  const frameworks = ["mix"];
  for (const name of ["phoenix", "phoenix_live_view", "ecto", "ecto_sql", "ash"]) {
    if (info.dependencies.has(name)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

async function detectRubyFrameworks(root: string): Promise<string[]> {
  const source = await rubyDependencySource(root);
  const frameworks: string[] = [];
  for (const name of ["jekyll", "rails", "sinatra"]) {
    if (new RegExp(`\\b${name}\\b`, "iu").test(source)) {
      frameworks.push(name);
    }
  }
  return frameworks;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function dependencyNames(pkg: PackageJson | null): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg?.dependencies, pkg?.devDependencies]) {
    if (typeof field !== "object" || field === null) {
      continue;
    }
    for (const name of Object.keys(field)) {
      names.add(name);
    }
  }
  return names;
}

async function detectLanguages(root: string): Promise<string[]> {
  const checks: Array<[string, string]> = [
    ["typescript", "tsconfig.json"],
    ["javascript", "package.json"],
    ["go", "go.mod"],
    ["rust", "Cargo.toml"],
    ["swift", "Package.swift"],
    ["python", "pyproject.toml"],
    ["python", "setup.py"],
    ["python", "setup.cfg"],
    ["python", "requirements.txt"],
    ["php", "composer.json"],
    ["php", "artisan"],
    ["elixir", "mix.exs"],
    ["ruby", "Gemfile"],
    ["ruby", "gems.rb"],
    ["ruby", "Rakefile"],
    ["ruby", "config.ru"],
  ];
  const languages: string[] = [];
  for (const [language, file] of checks) {
    if ((await pathExists(join(root, file))) && !languages.includes(language)) {
      languages.push(language);
    }
  }
  if (!languages.includes("python") && (await containsReviewablePythonFile(root))) {
    languages.push("python");
  }
  if (!languages.includes("java") && (await containsReviewableJavaFile(root))) {
    languages.push("java");
  }
  if (!languages.includes("ruby") && (await isRubyProject(root))) {
    languages.push("ruby");
  }
  if (
    !languages.includes("swift") &&
    ((await containsFileNamed(root, "Package.swift", 5)) ||
      (await containsFileWithExtension(root, ".swift", 5)))
  ) {
    languages.push("swift");
  }
  if (
    !languages.includes("kotlin") &&
    ((await containsReviewableKotlinFile(root)) ||
      (await containsFileWithExtension(root, ".kt", 5)) ||
      (await containsFileWithExtension(root, ".kts", 5)))
  ) {
    languages.push("kotlin");
  }
  if (!languages.includes("c") && (await containsCFile(root))) {
    languages.push("c");
  }
  if (!languages.includes("cpp") && (await containsCppFile(root))) {
    languages.push("cpp");
  }
  if (!languages.includes("php") && (await containsReviewablePhpFile(root))) {
    languages.push("php");
  }
  const dotnetProjectFiles = await collectDotnetFiles(root, isDotnetProjectFileName, 5);
  if (
    !languages.includes("csharp") &&
    (dotnetProjectFiles.some((path) => path.toLowerCase().endsWith(".csproj")) ||
      (await containsReviewableCsharpFile(root)))
  ) {
    languages.push("csharp");
  }
  if (
    !languages.includes("fsharp") &&
    dotnetProjectFiles.some((path) => path.toLowerCase().endsWith(".fsproj"))
  ) {
    languages.push("fsharp");
  }
  if (
    !languages.includes("visual-basic") &&
    dotnetProjectFiles.some((path) => path.toLowerCase().endsWith(".vbproj"))
  ) {
    languages.push("visual-basic");
  }
  return languages;
}

async function hasDotnetBuildManifest(root: string): Promise<boolean> {
  return (
    (await containsFileMatching(root, 5, isDotnetProjectFileName, shouldSkipDotnetSearchEntry)) ||
    (await containsFileMatching(root, 4, isDotnetSolutionFileName, shouldSkipDotnetSearchEntry))
  );
}

async function containsReviewableCsharpFile(root: string): Promise<boolean> {
  for (const prefix of ["src", "app", "apps", "lib", "test", "tests"]) {
    if (
      await containsFileWithExtension(
        join(root, prefix),
        ".cs",
        6,
        shouldSkipDotnetSearchEntry,
        prefix,
      )
    ) {
      return true;
    }
  }
  return containsFileWithExtension(root, ".cs", 1, shouldSkipDotnetSearchEntry);
}

async function containsCFile(root: string): Promise<boolean> {
  return containsFileWithExtension(root, ".c", 5, shouldSkipCOrCppSearchEntry);
}

async function containsCppFile(root: string): Promise<boolean> {
  return (
    (await containsFileWithExtension(root, ".C", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtension(root, ".H", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".cpp", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".cc", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".cxx", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".hpp", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".hh", 5, shouldSkipCOrCppSearchEntry)) ||
    (await containsFileWithExtensionIgnoringCase(root, ".hxx", 5, shouldSkipCOrCppSearchEntry))
  );
}

const jvmSourceSearchRoots = ["src", "app", "apps", "lib"] as const;

async function containsReviewableJavaFile(root: string): Promise<boolean> {
  return containsReviewableJvmFile(root, ".java");
}

async function containsReviewableKotlinFile(root: string): Promise<boolean> {
  return containsReviewableJvmFile(root, ".kt");
}

async function containsReviewableJvmFile(root: string, extension: string): Promise<boolean> {
  for (const prefix of jvmSourceSearchRoots) {
    if (await containsFileWithExtension(join(root, prefix), extension, 8, undefined, prefix)) {
      return true;
    }
  }
  return false;
}

async function isPythonProject(root: string): Promise<boolean> {
  return (
    (await pathExists(join(root, "pyproject.toml"))) ||
    (await pathExists(join(root, "setup.py"))) ||
    (await pathExists(join(root, "setup.cfg"))) ||
    (await pathExists(join(root, "requirements.txt"))) ||
    (await containsReviewablePythonFile(root))
  );
}

async function isRubyProject(root: string): Promise<boolean> {
  if (
    (await pathExists(join(root, "Gemfile"))) ||
    (await pathExists(join(root, "gems.rb"))) ||
    (await pathExists(join(root, "Rakefile"))) ||
    (await pathExists(join(root, "config.ru"))) ||
    (await rubyGemspecPaths(root, { includeNested: true })).length > 0
  ) {
    return true;
  }
  return containsReviewableRubyFile(root);
}

async function containsReviewablePythonFile(root: string): Promise<boolean> {
  if (await containsRootReviewablePythonFile(root)) {
    return true;
  }
  for (const prefix of pythonSourceSearchRoots) {
    if (
      await containsFileMatching(
        join(root, prefix),
        4,
        isReviewablePythonFileName,
        undefined,
        prefix,
      )
    ) {
      return true;
    }
  }
  return containsFileNamed(root, "__init__.py", 3);
}

async function containsReviewablePhpFile(root: string): Promise<boolean> {
  for (const prefix of ["app", "routes", "config", "database", "tests"]) {
    if (await containsFileWithExtension(join(root, prefix), ".php", 4, undefined, prefix)) {
      return true;
    }
  }
  return false;
}

const pythonSourceSearchRoots = ["src", "app", "apps", "lib", "scripts", "web"] as const;

async function containsRootReviewablePythonFile(root: string): Promise<boolean> {
  return (await readdir(root, { withFileTypes: true }).catch(() => [])).some(
    (entry) => entry.isFile() && isReviewablePythonFileName(entry.name),
  );
}

function isReviewablePythonFileName(entry: string): boolean {
  return (
    entry.endsWith(".py") &&
    !/^test_[^/]+\.py$/u.test(entry) &&
    !entry.endsWith("_test.py") &&
    !/(?:generated|_pb2|_pb2_grpc|\.gen)\.py$/iu.test(entry)
  );
}

async function pythonImportedFrameworks(root: string): Promise<string[]> {
  const frameworks = new Set<string>();
  for (const path of await pythonFrameworkScanFiles(root)) {
    const source = await readFile(path, "utf8").catch(() => "");
    for (const name of ["flask", "fastapi", "django"] as const) {
      const importPattern = new RegExp(
        `^\\s*(?:from\\s+${name}\\s+import\\s+|import\\s+${name}\\b)`,
        "mu",
      );
      if (importPattern.test(source)) {
        frameworks.add(name);
      }
    }
  }
  return [...frameworks];
}

async function pythonFrameworkScanFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && isReviewablePythonFileName(entry.name)) {
      files.push(join(root, entry.name));
    }
  }
  for (const prefix of pythonSourceSearchRoots) {
    await collectPythonFrameworkScanFiles(join(root, prefix), 4, files, prefix);
  }
  return [...new Set(files)].slice(0, 200);
}

async function collectPythonFrameworkScanFiles(
  dir: string,
  remainingDepth: number,
  files: string[],
  relativeDir = "",
): Promise<void> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = relativeDir === "" ? entry.name : `${relativeDir}/${entry.name}`;
    if (shouldSkipSearchEntry(entry.name, path)) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isFile() && isReviewablePythonFileName(entry.name)) {
      files.push(full);
    } else if (entry.isDirectory()) {
      await collectPythonFrameworkScanFiles(full, remainingDepth - 1, files, path);
    }
  }
}

async function containsReviewableRubyFile(root: string): Promise<boolean> {
  if (await containsFileMatching(root, 0, isRootReviewableRubyFileName)) {
    return true;
  }
  for (const prefix of ["app", "lib"]) {
    if (
      await containsFileMatching(join(root, prefix), 4, isReviewableRubyFileName, undefined, prefix)
    ) {
      return true;
    }
  }
  for (const prefix of ["scripts", "script", "exe", "bin"]) {
    if (await containsRubyExecutableSource(join(root, prefix), 4, prefix)) {
      return true;
    }
  }
  return false;
}

function isReviewableRubyFileName(entry: string): boolean {
  return (
    entry.endsWith(".rb") &&
    !entry.endsWith("_spec.rb") &&
    !entry.endsWith("_test.rb") &&
    !/(?:generated|\.gen)\.rb$/iu.test(entry)
  );
}

function isRootReviewableRubyFileName(entry: string): boolean {
  return isReviewableRubyFileName(entry) && !entry.startsWith("test_");
}

async function containsRubyExecutableSource(
  dir: string,
  remainingDepth: number,
  relativeDir = "",
): Promise<boolean> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return false;
  }
  for (const entry of await readdir(dir)) {
    const path = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
    if (shouldSkipSearchEntry(entry, path)) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (
      info.isFile() &&
      (isReviewableRubyFileName(entry) ||
        (isRubyShebangCandidate(entry) && (await fileHasRubyShebang(full))))
    ) {
      return true;
    }
    if (
      info.isDirectory() &&
      (await containsRubyExecutableSource(full, remainingDepth - 1, path))
    ) {
      return true;
    }
  }
  return false;
}

function isRubyShebangCandidate(path: string): boolean {
  return !path.includes(".");
}

async function containsRubySpecFile(root: string, maxDepth: number): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry.endsWith("_spec.rb"));
}

async function containsRubyTestFile(root: string, maxDepth: number): Promise<boolean> {
  return (
    (await containsFileMatching(root, maxDepth, (entry) => entry.endsWith("_test.rb"))) ||
    (await containsRubyPrefixedMinitestFile(root, maxDepth))
  );
}

function isRubyPrefixedMinitestFileName(entry: string): boolean {
  return /^test_.+\.rb$/u.test(entry) && !/^test_helpers?\.rb$/u.test(entry);
}

async function containsRubyPrefixedMinitestFile(
  dir: string,
  remainingDepth: number,
  relativeDir = "",
): Promise<boolean> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return false;
  }
  for (const entry of await readdir(dir)) {
    if (shouldSkipSearchEntry(entry)) {
      continue;
    }
    const full = join(dir, entry);
    const path = relativeDir === "" ? entry : `${relativeDir}/${entry}`;
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (
      info.isFile() &&
      isRubyPrefixedMinitestFileName(entry) &&
      (relativeDir === "" || /(^|\/)test$/u.test(relativeDir))
    ) {
      return true;
    }
    if (
      info.isDirectory() &&
      (await containsRubyPrefixedMinitestFile(full, remainingDepth - 1, path))
    ) {
      return true;
    }
  }
  return false;
}

async function containsFileNamed(
  root: string,
  name: string,
  maxDepth: number,
  skipEntry: (entry: string, relativePath: string) => boolean = shouldSkipSearchEntry,
): Promise<boolean> {
  return containsFileMatching(root, maxDepth, (entry) => entry === name, skipEntry);
}

async function containsFileWithExtension(
  root: string,
  extension: string,
  maxDepth: number,
  skipEntry: (entry: string, relativePath: string) => boolean = shouldSkipSearchEntry,
  relativeDir = "",
): Promise<boolean> {
  return containsFileMatching(
    root,
    maxDepth,
    (entry) => entry.endsWith(extension),
    skipEntry,
    relativeDir,
  );
}

async function containsFileWithExtensionIgnoringCase(
  root: string,
  extension: string,
  maxDepth: number,
  skipEntry: (entry: string, relativePath: string) => boolean = shouldSkipSearchEntry,
  relativeDir = "",
): Promise<boolean> {
  const lowercaseExtension = extension.toLowerCase();
  return containsFileMatching(
    root,
    maxDepth,
    (entry) => entry.toLowerCase().endsWith(lowercaseExtension),
    skipEntry,
    relativeDir,
  );
}

async function containsFileMatching(
  dir: string,
  remainingDepth: number,
  predicate: (entry: string) => boolean,
  skipEntry: (entry: string, relativePath: string) => boolean = shouldSkipSearchEntry,
  relativeDir = "",
): Promise<boolean> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return false;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return false;
  }
  for (const entry of await readdir(dir)) {
    const relativePath = relativeDir.length === 0 ? entry : `${relativeDir}/${entry}`;
    if (skipEntry(entry, relativePath)) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && predicate(entry)) {
      return true;
    }
    if (
      info.isDirectory() &&
      (await containsFileMatching(full, remainingDepth - 1, predicate, skipEntry, relativePath))
    ) {
      return true;
    }
  }
  return false;
}

function shouldSkipSearchEntry(entry: string, relativePath = entry): boolean {
  if (entry === "vendor" && relativePath === "vendor") {
    return true;
  }
  return [
    "node_modules",
    "deps",
    "dist",
    "build",
    "target",
    ".build",
    ".swiftpm",
    ".git",
    ".clawpatch",
    ".worktrees",
    ".venv",
    "venv",
    "__pycache__",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    ".bundle",
    "fixtures",
    "__fixtures__",
    "testdata",
    "Pods",
    "Carthage",
    "SourcePackages",
    "DerivedData",
  ].includes(entry);
}

function shouldSkipDotnetSearchEntry(entry: string, relativePath = entry): boolean {
  return (
    shouldSkipSearchEntry(entry, relativePath) ||
    ["bin", "obj", "TestResults", ".vs"].includes(entry) ||
    isDotnetPackageCachePath(relativePath)
  );
}

function isDotnetPackageCachePath(path: string): boolean {
  return /(^|\/)\.nuget\/(?:packages|fallbackpackages)(\/|$)/iu.test(path);
}

function shouldSkipCOrCppSearchEntry(entry: string): boolean {
  return (
    shouldSkipSearchEntry(entry) ||
    entry === "vendor" ||
    entry === "CMakeFiles" ||
    /^cmake-build-[^/]+$/u.test(entry)
  );
}

async function collectDotnetFiles(
  root: string,
  predicate: (entry: string) => boolean,
  maxDepth: number,
): Promise<string[]> {
  const files: string[] = [];
  await collectDotnetFilesAt(root, maxDepth, predicate, files);
  return [...new Set(files)].toSorted();
}

async function collectMavenPomFiles(root: string, maxDepth: number): Promise<string[]> {
  const files: string[] = [];
  await collectMavenPomFilesAt(root, maxDepth, files);
  return [...new Set(files)].toSorted();
}

async function collectMavenPomFilesAt(
  dir: string,
  remainingDepth: number,
  files: string[],
  relativeDir = "",
): Promise<void> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(dir)) {
    const relativePath = relativeDir.length === 0 ? entry : `${relativeDir}/${entry}`;
    if (shouldSkipSearchEntry(entry, relativePath)) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && entry === "pom.xml") {
      files.push(relativePath);
    } else if (info.isDirectory()) {
      await collectMavenPomFilesAt(full, remainingDepth - 1, files, relativePath);
    }
  }
}

async function collectDotnetFilesAt(
  dir: string,
  remainingDepth: number,
  predicate: (entry: string) => boolean,
  files: string[],
  relativeDir = "",
): Promise<void> {
  if (remainingDepth < 0 || !(await pathExists(dir))) {
    return;
  }
  const dirInfo = await lstat(dir);
  if (!dirInfo.isDirectory() || dirInfo.isSymbolicLink()) {
    return;
  }
  for (const entry of await readdir(dir)) {
    const relativePath = relativeDir.length === 0 ? entry : `${relativeDir}/${entry}`;
    if (shouldSkipDotnetSearchEntry(entry, relativePath)) {
      continue;
    }
    const full = join(dir, entry);
    const info = await lstat(full);
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isFile() && predicate(entry)) {
      files.push(relativePath);
    } else if (info.isDirectory()) {
      await collectDotnetFilesAt(full, remainingDepth - 1, predicate, files, relativePath);
    }
  }
}

function isDotnetProjectFileName(entry: string): boolean {
  return /\.(?:cs|fs|vb)proj$/iu.test(entry);
}

function isDotnetSolutionFileName(entry: string): boolean {
  return /\.(?:sln|slnx)$/iu.test(entry);
}

function isDotnetSlnxFileName(entry: string): boolean {
  return /\.slnx$/iu.test(entry);
}

function isStrongDotnetTestProject(source: string): boolean {
  const activeSource = stripXmlComments(source);
  return hasDotnetTestFrameworkEvidence(activeSource);
}

function hasDotnetTestFrameworkEvidence(source: string): boolean {
  return (
    /<IsTestProject>\s*true\s*<\/IsTestProject>/iu.test(source) ||
    /<Project\b[^>]*\bSdk\s*=\s*["']MSTest\.Sdk(?:\/|["'])/iu.test(source) ||
    /<Sdk\b[^>]*\bName\s*=\s*["']MSTest\.Sdk["']/iu.test(source) ||
    /<PackageReference\b[^>]*\bInclude\s*=\s*["'](?:Microsoft\.NET\.Test\.Sdk|xunit|xunit\.v3|NUnit|NUnit3TestAdapter|MSTest\.TestFramework|Microsoft\.Testing\.Platform\.MSBuild|TUnit)["']/iu.test(
      source,
    )
  );
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

function isDotnetWebProject(source: string): boolean {
  return (
    /<Project\b[^>]*\bSdk\s*=\s*["']Microsoft\.NET\.Sdk\.Web(?:\/|["'])/iu.test(source) ||
    /<Sdk\b[^>]*\bName\s*=\s*["']Microsoft\.NET\.Sdk\.Web["']/iu.test(source) ||
    /<FrameworkReference\b[^>]*\bInclude\s*=\s*["']Microsoft\.AspNetCore\.App["']/iu.test(source) ||
    /<PackageReference\b[^>]*\bInclude\s*=\s*["']Microsoft\.AspNetCore\./iu.test(source)
  );
}

function stripLineComments(source: string, marker: "#" | "//"): string {
  return source
    .split("\n")
    .map((line) => stripLineComment(line, marker))
    .join("\n");
}

function stripSwiftComments(source: string): string {
  return stripLineComments(stripBlockComments(source), "//");
}

function stripBlockComments(source: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      output += char;
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "/" && next === "*") {
      let depth = 1;
      output += "  ";
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          output += "  ";
          depth += 1;
          index += 2;
          continue;
        }
        if (source[index] === "*" && source[index + 1] === "/") {
          output += "  ";
          depth -= 1;
          index += 2;
          continue;
        }
        output += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      index -= 1;
    } else {
      output += char;
    }
  }
  return output;
}

function stripLineComment(line: string, marker: "#" | "//"): string {
  let inString = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (line.startsWith(marker, index)) {
      return line.slice(0, index);
    }
  }
  return line;
}
