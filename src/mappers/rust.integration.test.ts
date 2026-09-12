import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";

const symlinkIt = process.platform === "win32" ? it.skip : it;

describe("mapFeatures", () => {
  it("maps Rust commands, libraries, integration tests, and Cargo defaults", async () => {
    const root = await fixtureRoot("clawpatch-rust-map-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rusty-tool"\n');
    await writeFixture(root, "src/main.rs", "fn main() {}\n");
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");
    await writeFixture(root, "src/bin/worker.rs", "fn main() {}\n");
    await writeFixture(root, "src/bin/admin/main.rs", "fn main() {}\n");
    await writeFixture(root, "crates/member/Cargo.toml", '[package]\nname = "member"\n');
    await writeFixture(root, "crates/member/src/lib.rs", "pub fn member() {}\n");
    await writeFixture(
      root,
      "crates/member/tests/member_integration.rs",
      "#[test]\nfn works() {}\n",
    );
    await writeFixture(root, "tests/integration.rs", "#[test]\nfn works() {}\n");
    await writeFixture(root, "tests/app.test.ts", "test('js', () => {});\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(project.detected.languages).toContain("rust");
    expect(project.detected.packageManagers).toContain("cargo");
    expect(project.detected.commands.typecheck).toBe("cargo check --workspace --all-targets");
    expect(project.detected.commands.format).toBe("cargo fmt --all --check");
    expect(project.detected.commands.test).toBe("cargo test --workspace");
    expect(titles).toContain("Rust command admin");
    expect(titles).toContain("Rust command rusty-tool");
    expect(titles).toContain("Rust command worker");
    expect(titles).toContain("Rust library rusty-tool");
    expect(titles).toContain("Rust library member");
    expect(titles).toContain("Rust integration test integration");
    expect(titles).toContain("Rust integration test member/member_integration");
    expect(
      result.features.find((feature) => feature.title === "Rust library rusty-tool")?.tests,
    ).toEqual([{ path: "tests/integration.rs", command: "cargo test --workspace" }]);
    expect(
      result.features.find((feature) => feature.title === "Rust library member")?.tests,
    ).toEqual([
      {
        path: "crates/member/tests/member_integration.rs",
        command: "cargo test --manifest-path crates/member/Cargo.toml",
      },
    ]);
  });

  it("quotes conventional Rust crate manifest paths with shell metacharacters", async () => {
    const root = await fixtureRoot("clawpatch-rust-quoted-manifest-path-");
    const memberRoot = "crates/member; touch INJECTED";
    await writeFixture(root, "Cargo.toml", "[workspace]\n");
    await writeFixture(root, `${memberRoot}/Cargo.toml`, '[package]\nname = "member"\n');
    await writeFixture(root, `${memberRoot}/src/lib.rs`, "pub fn run() {}\n");
    await writeFixture(root, `${memberRoot}/tests/member_test.rs`, "#[test]\nfn works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const library = result.features.find((feature) => feature.title === "Rust library member");

    expect(library?.tests).toEqual([
      {
        path: `${memberRoot}/tests/member_test.rs`,
        command: 'cargo test --manifest-path "crates/member; touch INJECTED/Cargo.toml"',
      },
    ]);
  });

  it("bounds Rust integration tests attached to entrypoint features", async () => {
    const root = await fixtureRoot("clawpatch-rust-test-bound-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rust-test-bound"\n');
    await writeFixture(root, "src/lib.rs", "pub fn run() {}\n");
    for (let index = 1; index <= 8; index += 1) {
      await writeFixture(root, `tests/test_${index}.rs`, "#[test]\nfn works() {}\n");
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const library = result.features.find(
      (feature) => feature.title === "Rust library rust-test-bound",
    );
    const integrationTests = result.features.filter(
      (feature) => feature.source === "rust-integration-test",
    );

    expect(library?.tests).toHaveLength(5);
    expect(library?.contextFiles).toHaveLength(6);
    expect(integrationTests).toHaveLength(8);
  });

  it("maps Rust source groups for crate modules without re-owning entrypoints", async () => {
    const root = await fixtureRoot("clawpatch-rust-source-groups-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[workspace]\nmembers = ["crates/core", "crates/cli"]\n',
    );
    await writeFixture(root, "crates/core/Cargo.toml", '[package]\nname = "core"\n');
    await writeFixture(root, "crates/core/src/lib.rs", "pub mod auth;\npub mod storage;\n");
    await writeFixture(root, "crates/core/src/auth/mod.rs", "pub fn login() {}\n");
    await writeFixture(root, "crates/core/src/auth/token.rs", "pub fn mint() {}\n");
    await writeFixture(root, "crates/core/src/storage/mod.rs", "pub fn open() {}\n");
    await writeFixture(root, "crates/core/src/storage/db.rs", "pub fn connect() {}\n");
    await writeFixture(root, "crates/cli/Cargo.toml", '[package]\nname = "cli"\n');
    await writeFixture(root, "crates/cli/src/main.rs", "fn main() {}\n");
    await writeFixture(root, "crates/cli/src/commands.rs", "pub fn run() {}\n");
    await writeFixture(root, "crates/cli/src/bin/worker.rs", "fn main() {}\n");
    await writeFixture(root, "crates/cli/src/bin/admin/main.rs", "fn main() {}\n");
    await writeFixture(root, "crates/cli/src/bin/admin/helpers.rs", "pub fn prep() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const sourceGroups = result.features.filter(
      (feature) => feature.source === "rust-source-group",
    );
    const owned = sourceGroups.flatMap((feature) => feature.ownedFiles.map((file) => file.path));
    const titles = sourceGroups.map((feature) => feature.title);

    expect(sourceGroups.length).toBeGreaterThanOrEqual(2);
    expect(owned).toContain("crates/core/src/auth/mod.rs");
    expect(owned).toContain("crates/core/src/auth/token.rs");
    expect(owned).toContain("crates/core/src/storage/mod.rs");
    expect(owned).toContain("crates/core/src/storage/db.rs");
    expect(owned).toContain("crates/cli/src/commands.rs");
    expect(owned).toContain("crates/cli/src/bin/admin/helpers.rs");
    expect(owned).not.toContain("crates/core/src/lib.rs");
    expect(owned).not.toContain("crates/cli/src/main.rs");
    expect(owned).not.toContain("crates/cli/src/bin/worker.rs");
    expect(owned).not.toContain("crates/cli/src/bin/admin/main.rs");
    expect(titles.some((title) => title.includes("crates/core/src"))).toBe(true);
    expect(
      sourceGroups.find((feature) =>
        feature.ownedFiles.some((file) => file.path === "crates/core/src/auth/mod.rs"),
      ),
    ).toMatchObject({
      kind: "library",
      confidence: "medium",
      tags: expect.arrayContaining(["rust", "source-group"]),
      contextFiles: [{ path: "crates/core/Cargo.toml", reason: "cargo package manifest" }],
      tests: [],
    });
    expect(sourceGroups.every((feature) => feature.ownedFiles.length <= 12)).toBe(true);
    expect(result.features.some((feature) => feature.title === "Rust library core")).toBe(true);
    expect(result.features.some((feature) => feature.title === "Rust command cli")).toBe(true);
    expect(result.features.some((feature) => feature.title === "Rust command worker")).toBe(true);
  });

  it("partitions oversized Rust source directories into bounded groups", async () => {
    const root = await fixtureRoot("clawpatch-rust-source-chunk-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "chunky"\n');
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    for (let index = 1; index <= 20; index += 1) {
      await writeFixture(root, `src/module_${index}.rs`, `pub fn f${index}() {}\n`);
    }

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const sourceGroups = result.features.filter(
      (feature) => feature.source === "rust-source-group",
    );
    const owned = sourceGroups.flatMap((feature) => feature.ownedFiles.map((file) => file.path));

    expect(sourceGroups.length).toBeGreaterThan(1);
    expect(owned).toHaveLength(20);
    expect(owned).not.toContain("src/lib.rs");
    expect(sourceGroups.every((feature) => feature.ownedFiles.length <= 12)).toBe(true);
    expect(sourceGroups.every((feature) => feature.entrypoints[0]?.path === "Cargo.toml")).toBe(
      true,
    );
    expect(
      sourceGroups.every((feature) =>
        feature.contextFiles.some(
          (file) => file.path === "Cargo.toml" && file.reason === "cargo package manifest",
        ),
      ),
    ).toBe(true);
  });

  it("keeps Rust source group identities stable when modules are added", async () => {
    const root = await fixtureRoot("clawpatch-rust-source-stable-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "stable"\n');
    await writeFixture(root, "src/lib.rs", "pub mod alpha;\n");
    await writeFixture(root, "src/alpha.rs", "pub fn a() {}\n");
    await writeFixture(root, "src/beta.rs", "pub fn b() {}\n");

    const project = await detectProject(root);
    const first = await mapFeatures(root, project, []);
    const firstGroups = first.features.filter((feature) => feature.source === "rust-source-group");
    const firstIds = firstGroups.map((feature) => feature.featureId).toSorted();

    await writeFixture(root, "src/aardvark.rs", "pub fn first() {}\n");
    const second = await mapFeatures(root, project, first.features);
    const secondGroups = second.features.filter(
      (feature) => feature.source === "rust-source-group",
    );
    const secondIds = secondGroups.map((feature) => feature.featureId).toSorted();

    expect(firstIds.length).toBeGreaterThan(0);
    for (const id of firstIds) {
      expect(secondIds).toContain(id);
    }
    expect(second.stale).toBe(0);
  });

  it("maps Cargo workspace members outside crates", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-");
    await writeFixture(root, "Cargo.toml", "[workspace]\nmembers = ['cli', 'core']\n");
    await writeFixture(root, "cli/Cargo.toml", '[package]\nname = "workspace-cli"\n');
    await writeFixture(root, "cli/src/main.rs", "fn main() {}\n");
    await writeFixture(root, "core/Cargo.toml", '[package]\nname = "workspace-core"\n');
    await writeFixture(root, "core/src/lib.rs", "pub fn run() {}\n");
    await writeFixture(root, "core/tests/core_integration.rs", "#[test]\nfn works() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust command workspace-cli");
    expect(titles).toContain("Rust library workspace-core");
    expect(titles).toContain("Rust integration test workspace-core/core_integration");
    expect(
      result.features.find((feature) => feature.title === "Rust library workspace-core")?.tests,
    ).toEqual([{ path: "core/tests/core_integration.rs", command: "cargo test --workspace" }]);
  });

  it("does not map virtual Cargo workspace root sources", async () => {
    const root = await fixtureRoot("clawpatch-rust-virtual-workspace-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["core"]\n');
    await writeFixture(root, "src/lib.rs", "pub fn ignored() {}\n");
    await writeFixture(root, "src/main.rs", "fn main() {}\n");
    await writeFixture(root, "tests/root.rs", "#[test]\nfn ignored() {}\n");
    await writeFixture(root, "core/Cargo.toml", '[package]\nname = "core"\n');
    await writeFixture(root, "core/src/lib.rs", "pub fn core() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library core");
    expect(titles).not.toContain("Rust library crate");
    expect(titles).not.toContain("Rust command crate");
    expect(titles).not.toContain("Rust integration test root");
  });

  it("reads Cargo package names from the package section", async () => {
    const root = await fixtureRoot("clawpatch-rust-package-name-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[workspace.metadata]
name = "workspace-name"

[package]
name = 'actual-pkg'
`,
    );
    await writeFixture(root, "src/main.rs", "fn main() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust command actual-pkg");
    expect(titles).not.toContain("Rust command workspace-name");
  });

  it("ignores commented and excluded Cargo workspace members", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-comments-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[workspace]
members = [
  # "old",
  "./crates/*/"
]
exclude = ["./crates/old/"]
`,
    );
    await writeFixture(root, "old/Cargo.toml", '[package]\nname = "old"\n');
    await writeFixture(root, "old/src/lib.rs", "pub fn old() {}\n");
    await writeFixture(root, "crates/old/Cargo.toml", '[package]\nname = "old-crate"\n');
    await writeFixture(root, "crates/old/src/lib.rs", "pub fn old_crate() {}\n");
    await writeFixture(root, "crates/core/Cargo.toml", '[package]\nname = "core"\n');
    await writeFixture(root, "crates/core/src/lib.rs", "pub fn core() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library core");
    expect(titles.filter((title) => title === "Rust library core")).toHaveLength(1);
    expect(titles).not.toContain("Rust library old");
    expect(titles).not.toContain("Rust library old-crate");
  });

  it("expands Cargo workspace member glob segments", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-glob-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["crates/o*"]\n');
    await writeFixture(root, "crates/old-one/Cargo.toml", '[package]\nname = "old-one"\n');
    await writeFixture(root, "crates/old-one/src/lib.rs", "pub fn old() {}\n");
    await writeFixture(root, "crates/new-one/Cargo.toml", '[package]\nname = "new-one"\n');
    await writeFixture(root, "crates/new-one/src/lib.rs", "pub fn new() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library old-one");
    expect(titles).not.toContain("Rust library new-one");
  });

  it("does not map Cargo workspace members without package manifests", async () => {
    const root = await fixtureRoot("clawpatch-rust-member-manifest-");
    await writeFixture(root, "Cargo.toml", '[workspace]\nmembers = ["crates/*"]\n');
    await writeFixture(root, "crates/template/src/lib.rs", "pub fn template() {}\n");
    await writeFixture(root, "crates/real/Cargo.toml", '[package]\nname = "real"\n');
    await writeFixture(root, "crates/real/src/lib.rs", "pub fn real() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library real");
    expect(titles).not.toContain("Rust library template");
  });

  it("ignores Cargo members outside the workspace section", async () => {
    const root = await fixtureRoot("clawpatch-rust-metadata-members-");
    await writeFixture(
      root,
      "Cargo.toml",
      `[package]
name = "root"

[package.metadata.foo]
members = ["tools/old"]
`,
    );
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(root, "tools/old/Cargo.toml", '[package]\nname = "old"\n');
    await writeFixture(root, "tools/old/src/lib.rs", "pub fn old() {}\n");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library root");
    expect(titles).not.toContain("Rust library old");
  });

  symlinkIt("skips duplicate and symlinked Cargo workspace members", async () => {
    const root = await fixtureRoot("clawpatch-rust-workspace-safe-");
    const external = await fixtureRoot("clawpatch-rust-workspace-external-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[package]\nname = "rootpkg"\n\n[workspace]\nmembers = [".", "linked/member"]\n',
    );
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(external, "member/Cargo.toml", '[package]\nname = "outside"\n');
    await writeFixture(external, "member/src/lib.rs", "pub fn outside() {}\n");
    await symlink(external, join(root, "linked"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles.filter((title) => title === "Rust library rootpkg")).toHaveLength(1);
    expect(titles).not.toContain("Rust library outside");
    expect(paths).not.toContain("./src/lib.rs");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });

  symlinkIt("does not scan symlinked conventional crates directories", async () => {
    const root = await fixtureRoot("clawpatch-rust-crates-symlink-root-");
    const external = await fixtureRoot("clawpatch-rust-crates-symlink-external-");
    await writeFixture(root, "Cargo.toml", '[package]\nname = "rootpkg"\n');
    await writeFixture(root, "src/lib.rs", "pub fn root() {}\n");
    await writeFixture(external, "member/Cargo.toml", '[package]\nname = "outside-member"\n');
    await writeFixture(external, "member/src/lib.rs", "pub fn outside() {}\n");
    await symlink(external, join(root, "crates"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);

    expect(titles).toContain("Rust library rootpkg");
    expect(titles).not.toContain("Rust library outside-member");
  });

  symlinkIt("does not map Rust entrypoints through symlinked source directories", async () => {
    const root = await fixtureRoot("clawpatch-rust-src-symlink-root-");
    const externalRoot = await fixtureRoot("clawpatch-rust-src-symlink-external-root-");
    const externalMember = await fixtureRoot("clawpatch-rust-src-symlink-external-member-");
    await writeFixture(
      root,
      "Cargo.toml",
      '[package]\nname = "rootpkg"\n\n[workspace]\nmembers = ["member"]\n',
    );
    await writeFixture(root, "member/Cargo.toml", '[package]\nname = "memberpkg"\n');
    await writeFixture(externalRoot, "lib.rs", "pub fn outside() {}\n");
    await writeFixture(externalMember, "lib.rs", "pub fn outside() {}\n");
    await symlink(externalRoot, join(root, "src"), "dir");
    await symlink(externalMember, join(root, "member/src"), "dir");

    const project = await detectProject(root);
    const result = await mapFeatures(root, project, []);
    const titles = result.features.map((feature) => feature.title);
    const paths = result.features.flatMap((feature) =>
      feature.entrypoints.map((entrypoint) => entrypoint.path),
    );

    expect(titles).not.toContain("Rust library rootpkg");
    expect(titles).not.toContain("Rust library memberpkg");
    expect(paths.some((path) => path.startsWith("../"))).toBe(false);
  });
});
