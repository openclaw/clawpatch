import { describe, expect, it } from "vitest";
import { rustSeeds } from "./rust.js";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";

async function createTempDir() {
  return await mkdtemp(join(tmpdir(), "clawpatch-rust-test-"));
}

describe("Rust Mapper", () => {
  it("populates contextFiles for a basic binary crate", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "Cargo.toml"),
      `
[package]
name = "my_bin"
version = "0.1.0"
`,
    );
    await writeFile(
      join(root, "src/main.rs"),
      `
mod api;
pub mod utils;
fn main() {}
`,
    );
    await writeFile(join(root, "src/api.rs"), "fn api() {}");
    await mkdir(join(root, "src/utils"), { recursive: true });
    await writeFile(join(root, "src/utils/mod.rs"), "fn utils() {}");

    const seeds = await rustSeeds(root);
    expect(seeds).toHaveLength(1);

    const contextPaths = seeds[0]!.contextFiles?.map((f) => f.path);
    expect(contextPaths).toEqual(["Cargo.toml", "src/api.rs", "src/utils/mod.rs"]);
  });

  it("cross-links lib.rs and main.rs", async () => {
    const root = await createTempDir();
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(
      join(root, "Cargo.toml"),
      `
[package]
name = "dual_crate"
`,
    );
    await writeFile(join(root, "src/main.rs"), "fn main() {}");
    await writeFile(join(root, "src/lib.rs"), "pub fn lib() {}");

    const seeds = await rustSeeds(root);
    expect(seeds).toHaveLength(2);

    const mainSeed = seeds.find((s) => s.entryPath === "src/main.rs")!;
    const libSeed = seeds.find((s) => s.entryPath === "src/lib.rs")!;

    expect(mainSeed.contextFiles?.map((f) => f.path)).toContain("src/lib.rs");
    expect(mainSeed.contextFiles?.map((f) => f.path)).toContain("Cargo.toml");

    expect(libSeed.contextFiles?.map((f) => f.path)).toContain("src/main.rs");
    expect(libSeed.contextFiles?.map((f) => f.path)).toContain("Cargo.toml");
  });

  it("resolves contextFiles for workspace members", async () => {
    const root = await createTempDir();
    await writeFile(
      join(root, "Cargo.toml"),
      `
[workspace]
members = ["crates/web", "crates/db"]
`,
    );

    await mkdir(join(root, "crates/web/src"), { recursive: true });
    await writeFile(join(root, "crates/web/Cargo.toml"), `[package]\nname="web"`);
    await writeFile(join(root, "crates/web/src/main.rs"), "mod routes;");
    await writeFile(join(root, "crates/web/src/routes.rs"), "");

    await mkdir(join(root, "crates/db/src"), { recursive: true });
    await writeFile(join(root, "crates/db/Cargo.toml"), `[package]\nname="db"`);
    await writeFile(join(root, "crates/db/src/lib.rs"), "mod models;");
    await writeFile(join(root, "crates/db/src/models.rs"), "");

    const seeds = await rustSeeds(root);
    expect(seeds).toHaveLength(2);

    const webSeed = seeds.find((s) => s.entryPath === "crates/web/src/main.rs")!;
    expect(webSeed.contextFiles?.map((f) => f.path)).toEqual([
      "crates/web/Cargo.toml",
      "crates/web/src/routes.rs",
    ]);

    const dbSeed = seeds.find((s) => s.entryPath === "crates/db/src/lib.rs")!;
    expect(dbSeed.contextFiles?.map((f) => f.path)).toEqual([
      "crates/db/Cargo.toml",
      "crates/db/src/models.rs",
    ]);
  });
});
