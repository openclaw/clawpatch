import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCommandArgs } from "./exec.js";
import { changedFilesSince, dirtyFiles } from "./git.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Git machine output", () => {
  it.each(["true", "copies", "false"])(
    "includes both committed rename paths with diff.renames=%s",
    async (renames) => {
      const root = await gitFixture();
      await git(root, ["config", "diff.renames", renames]);
      await git(root, ["mv", "base.txt", "renamed.txt"]);
      await git(root, ["commit", "-qm", "rename"]);

      expect(await changedFilesSince(root, "HEAD~1")).toEqual(new Set(["base.txt", "renamed.txt"]));
    },
  );

  it("scopes both sides of committed renames to a nested project", async () => {
    const root = await gitFixture();
    const project = join(root, "app");
    await mkdir(project);
    await writeFile(join(project, "outgoing.txt"), "outgoing\n");
    await writeFile(join(project, "before.txt"), "internal\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-qm", "nested project"]);
    await git(root, ["config", "diff.renames", "true"]);
    await git(root, ["mv", "base.txt", "app/incoming.txt"]);
    await git(root, ["mv", "app/outgoing.txt", "outside.txt"]);
    await git(root, ["mv", "app/before.txt", "app/after.txt"]);
    await git(root, ["commit", "-qm", "move across project boundaries"]);

    expect(await changedFilesSince(project, "HEAD~1")).toEqual(
      new Set(["incoming.txt", "outgoing.txt", "before.txt", "after.txt"]),
    );
  });

  it.skipIf(process.platform === "win32")(
    "preserves unusual filenames in committed and dirty sets",
    async () => {
      const root = await gitFixture();
      const committed = [
        " leading.ts",
        "trailing.ts ",
        "line\nbreak.ts",
        "slash\\name.ts",
        "café.ts",
      ];
      for (const path of committed) {
        await writeFile(join(root, path), path, "utf8");
      }
      await git(root, ["add", "--all"]);
      await git(root, ["commit", "-qm", "unusual paths"]);

      expect(await changedFilesSince(root, "HEAD~1")).toEqual(new Set(committed));

      const dirty = [" dirty.ts", "dirty\nfile.ts", "dirty\\file.ts"];
      for (const path of dirty) {
        await writeFile(join(root, path), path, "utf8");
      }
      expect(await dirtyFiles(root)).toEqual(new Set(dirty));
    },
  );

  it("rejects option-like refs before invoking Git", async () => {
    await expect(changedFilesSince("/missing", "--output=/tmp/leak")).rejects.toMatchObject({
      code: "invalid-input",
    });
  });
});

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "clawpatch-git-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.com"]);
  await git(root, ["config", "user.name", "Test"]);
  await writeFile(join(root, "base.txt"), "base\n", "utf8");
  await git(root, ["add", "base.txt"]);
  await git(root, ["commit", "-qm", "base"]);
  return root;
}

async function git(root: string, args: string[]): Promise<void> {
  const result = await runCommandArgs("git", args, root);
  expect(result.exitCode, result.stderr).toBe(0);
}
