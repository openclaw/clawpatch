import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "../fs.js";
import { shellQuotePath } from "../shell.js";
import {
  isSafeDirectory,
  isSafeFile,
  packageTrustBoundaries,
  normalize,
  stripLineComments,
  walk,
} from "./shared.js";
import { FeatureSeed } from "./types.js";

const rustFeatureTestLimit = 5;

type RustTestRef = {
  path: string;
  command: string | null;
};

export async function rustSeeds(root: string): Promise<FeatureSeed[]> {
  if (!(await pathExists(join(root, "Cargo.toml")))) {
    return [];
  }
  const packageName = await rustPackageName(root);
  const rootHasPackage = await hasCargoPackageManifest(root, "Cargo.toml");
  const rustTestCommand = "cargo test --workspace";
  const seeds: FeatureSeed[] = [];
  const rootTests = rootHasPackage
    ? await rustIntegrationTests(root, "tests", rustTestCommand)
    : [];
  const rootFeatureTests = rootTests.slice(0, rustFeatureTestLimit);
  if (rootHasPackage && (await isSafeFile(root, join(root, "src/main.rs")))) {
    seeds.push(rustCommandSeed("src/main.rs", packageName, rustTestCommand, rootFeatureTests));
  }
  if (rootHasPackage && (await isSafeFile(root, join(root, "src/lib.rs")))) {
    seeds.push(rustLibrarySeed("src/lib.rs", packageName, rustTestCommand, rootFeatureTests));
  }
  if (rootHasPackage) {
    for (const file of (await walk(root, ["src/bin"])).filter((candidate) =>
      /^src\/bin\/([^/]+\.rs|[^/]+\/main\.rs)$/u.test(candidate),
    )) {
      seeds.push(rustCommandSeed(file, rustBinCommand(file), rustTestCommand, rootFeatureTests));
    }
    for (const test of rootTests) {
      const name = test.path.split("/").at(-1)?.replace(/\.rs$/u, "") ?? "integration";
      seeds.push(rustIntegrationTestSeed(test.path, name, rustTestCommand));
    }
  }
  for (const member of await rustMemberDirs(root)) {
    const memberDir = member.dir;
    const memberFallback = memberDir.split("/").at(-1) ?? "crate";
    const memberName = await rustPackageName(root, `${memberDir}/Cargo.toml`, memberFallback);
    const memberMain = `${memberDir}/src/main.rs`;
    const memberLib = `${memberDir}/src/lib.rs`;
    const memberTests = await rustIntegrationTests(root, `${memberDir}/tests`, member.testCommand);
    const memberFeatureTests = memberTests.slice(0, rustFeatureTestLimit);
    if (await isSafeFile(root, join(root, memberMain))) {
      seeds.push(rustCommandSeed(memberMain, memberName, member.testCommand, memberFeatureTests));
    }
    if (await isSafeFile(root, join(root, memberLib))) {
      seeds.push(rustLibrarySeed(memberLib, memberName, member.testCommand, memberFeatureTests));
    }
    for (const file of (await walk(root, [`${memberDir}/src/bin`])).filter(isRustBinFile)) {
      seeds.push(
        rustCommandSeed(file, rustBinCommand(file), member.testCommand, memberFeatureTests),
      );
    }
    for (const test of memberTests) {
      const name = test.path.split("/").at(-1)?.replace(/\.rs$/u, "") ?? "integration";
      seeds.push(rustIntegrationTestSeed(test.path, `${memberName}/${name}`, member.testCommand));
    }
  }
  return seeds;
}

type RustMemberDir = {
  dir: string;
  testCommand: string | null;
};

async function rustMemberDirs(root: string): Promise<RustMemberDir[]> {
  const dirs = new Map<string, RustMemberDir>();
  const workspace = await cargoWorkspace(root);
  for (const member of workspace.members) {
    dirs.set(member, { dir: member, testCommand: "cargo test --workspace" });
  }
  if (!workspace.membersDeclared) {
    for (const member of await conventionalCrateDirs(root, workspace.excluded)) {
      dirs.set(member, {
        dir: member,
        // `member` is a directory name discovered via readdir, so a crate dir
        // literally named e.g. `$(id)` would inject under `spawn(_, {shell:true})`.
        // Quote it like every other filesystem-derived validation-command fragment.
        testCommand: `cargo test --manifest-path ${shellQuotePath(`${member}/Cargo.toml`)}`,
      });
    }
  }
  return [...dirs.values()].toSorted((a, b) => a.dir.localeCompare(b.dir));
}

async function cargoWorkspace(root: string): Promise<{
  members: string[];
  membersDeclared: boolean;
  excluded: Set<string>;
}> {
  const manifest = stripLineComments(await readFile(join(root, "Cargo.toml"), "utf8"), "#");
  const workspace = cargoSection(manifest, "workspace");
  const members = cargoArrayValues(workspace, "members");
  const membersDeclared = /^\s*members\s*=/mu.test(workspace);
  const excluded = new Set(cargoArrayValues(workspace, "exclude").map(cargoMemberPath));
  const dirs: string[] = [];
  for (const value of members) {
    const member = cargoMemberPath(value);
    if (!isSafeMemberPattern(member)) {
      continue;
    }
    if (hasMemberGlob(member)) {
      dirs.push(...(await expandMemberPattern(root, member, excluded)));
    } else if (
      !excluded.has(member) &&
      (await isSafeDirectory(root, join(root, member))) &&
      (await isRustPackageDir(root, member))
    ) {
      dirs.push(member);
    }
  }
  return { members: dirs, membersDeclared, excluded };
}

function cargoSection(manifest: string, name: string): string {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`^\\s*\\[${escapedName}\\]\\s*$`, "mu").exec(manifest);
  if (match?.index === undefined) {
    return "";
  }
  const rest = manifest.slice(match.index + match[0].length);
  const nextSection = /^\s*\[[^\]]+\]\s*$/mu.exec(rest);
  return nextSection?.index === undefined ? rest : rest.slice(0, nextSection.index);
}

function cargoArrayValues(manifest: string, key: string): string[] {
  const values =
    new RegExp(`^\\s*${key}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "mu").exec(manifest)?.[1] ?? "";
  return [...values.matchAll(/(["'])([^"']+)\1/gu)].flatMap((match) =>
    match[2] === undefined ? [] : [match[2]],
  );
}

function cargoStringValue(manifest: string, key: string): string | null {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return (
    new RegExp(`^\\s*${escapedKey}\\s*=\\s*(["'])([^"']+)\\1`, "mu").exec(manifest)?.[2] ?? null
  );
}

function cargoMemberPath(path: string): string {
  return normalize(path).replace(/^\.\//u, "").replace(/\/+$/u, "");
}

async function conventionalCrateDirs(root: string, excluded: Set<string>): Promise<string[]> {
  const cratesDir = join(root, "crates");
  if (!(await isSafeDirectory(root, cratesDir))) {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of await readdir(cratesDir)) {
    const member = `crates/${entry}`;
    if (
      !excluded.has(member) &&
      (await isSafeDirectory(root, join(root, member))) &&
      (await isRustPackageDir(root, member))
    ) {
      dirs.push(member);
    }
  }
  return dirs;
}

async function expandMemberPattern(
  root: string,
  pattern: string,
  excluded: Set<string>,
): Promise<string[]> {
  const members: string[] = [];
  const parts = pattern.split("/");
  async function visit(base: string, remaining: string[]): Promise<void> {
    const [part, ...rest] = remaining;
    if (part === undefined) {
      if (
        !excluded.has(base) &&
        (await isSafeDirectory(root, join(root, base))) &&
        (await isRustPackageDir(root, base))
      ) {
        members.push(base);
      }
      return;
    }
    if (!hasMemberGlob(part)) {
      await visit(base.length === 0 ? part : `${base}/${part}`, rest);
      return;
    }
    if (!(await isSafeDirectory(root, join(root, base)))) {
      return;
    }
    const matcher = globSegmentRegExp(part);
    for (const entry of await readdir(join(root, base))) {
      if (!matcher.test(entry)) {
        continue;
      }
      await visit(base.length === 0 ? entry : `${base}/${entry}`, rest);
    }
  }
  await visit("", parts);
  return members;
}

async function isRustPackageDir(root: string, dir: string): Promise<boolean> {
  return hasCargoPackageManifest(root, dir.length === 0 ? "Cargo.toml" : `${dir}/Cargo.toml`);
}

function isSafeMemberPath(path: string): boolean {
  return (
    path.length > 0 && path !== "." && !path.startsWith("/") && !path.split("/").includes("..")
  );
}

function isSafeMemberPattern(path: string): boolean {
  return isSafeMemberPath(path.replace(/[*?]/gu, "x"));
}

function hasMemberGlob(path: string): boolean {
  return /[*?]/u.test(path);
}

function globSegmentRegExp(segment: string): RegExp {
  const escaped = segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u");
}

function rustCommandSeed(
  file: string,
  command: string,
  testCommand: string | null = null,
  tests: RustTestRef[] = [],
): FeatureSeed {
  return {
    title: `Rust command ${command}`,
    summary: `Rust executable command at ${file}.`,
    kind: "cli-command",
    source: "rust-command",
    confidence: "high",
    entryPath: file,
    symbol: "main",
    route: null,
    command,
    tags: ["rust", "cli"],
    trustBoundaries: ["user-input", "filesystem", "process-exec", "network"],
    tests,
    testCommand,
    skipNearbyTests: true,
  };
}

function rustLibrarySeed(
  file: string,
  name: string,
  testCommand: string | null = null,
  tests: RustTestRef[] = [],
): FeatureSeed {
  return {
    title: `Rust library ${name}`,
    summary: `Rust library crate at ${file}.`,
    kind: "library",
    source: "rust-library",
    confidence: "high",
    entryPath: file,
    symbol: null,
    route: null,
    command: null,
    tags: ["rust", "library"],
    trustBoundaries: packageTrustBoundaries(name),
    tests,
    testCommand,
    skipNearbyTests: true,
  };
}

function rustBinCommand(file: string): string {
  const parts = file.split("/");
  const binIndex = parts.lastIndexOf("bin");
  if (parts.at(binIndex + 2) === "main.rs") {
    return parts.at(binIndex + 1) ?? "bin";
  }
  return parts.at(-1)?.replace(/\.rs$/u, "") ?? "bin";
}

function isRustBinFile(file: string): boolean {
  return /\/src\/bin\/([^/]+\.rs|[^/]+\/main\.rs)$/u.test(file);
}

function rustIntegrationTestSeed(
  file: string,
  name: string,
  testCommand: string | null = null,
): FeatureSeed {
  return {
    title: `Rust integration test ${name}`,
    summary: `Rust integration test entrypoint at ${file}.`,
    kind: "test-suite",
    source: "rust-integration-test",
    confidence: "medium",
    entryPath: file,
    symbol: null,
    route: null,
    command: null,
    tags: ["rust", "test"],
    trustBoundaries: [],
    testCommand,
    skipNearbyTests: true,
  };
}

async function rustIntegrationTests(
  root: string,
  prefix: string,
  command: string | null,
): Promise<RustTestRef[]> {
  return (await walk(root, [prefix]))
    .filter((candidate) => new RegExp(`^${escapeRegExp(prefix)}/[^/]+\\.rs$`, "u").test(candidate))
    .map((path) => ({ path, command }));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

async function rustPackageName(
  root: string,
  manifestPath = "Cargo.toml",
  fallback = "crate",
): Promise<string> {
  try {
    if (!(await isSafeFile(root, join(root, manifestPath)))) {
      return fallback;
    }
    const manifest = stripLineComments(await readFile(join(root, manifestPath), "utf8"), "#");
    return cargoStringValue(cargoSection(manifest, "package"), "name") ?? fallback;
  } catch {
    return fallback;
  }
}

async function hasCargoPackageManifest(root: string, manifestPath: string): Promise<boolean> {
  const full = join(root, manifestPath);
  if (!(await isSafeFile(root, full))) {
    return false;
  }
  const manifest = stripLineComments(await readFile(full, "utf8"), "#");
  return cargoSection(manifest, "package").trim().length > 0;
}
