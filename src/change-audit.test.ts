import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changedPathsBetweenSnapshots,
  hasSourceDirtyWorktree,
  sourceChangedSnapshots,
} from "./change-audit.js";
import { runCommandArgs } from "./exec.js";
import { fixtureRoot, writeFixture } from "./test-helpers.js";

async function nestedProject() {
  const root = await fixtureRoot("clawpatch-nested-audit-");
  await writeFixture(root, "app/src/index.ts", "export const value = 1;\n");
  await writeFixture(root, "sibling.txt", "original\n");
  for (const args of [
    ["init", "-q"],
    ["add", "."],
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ],
  ]) {
    const result = await runCommandArgs("git", args, root);
    expect(result.exitCode, result.stderr).toBe(0);
  }
  return { root, project: join(root, "app"), state: join(root, "app/.clawpatch") };
}

describe("project-scoped change audit", () => {
  it("ignores nested project state and changes outside the selected project", async () => {
    const { root, project, state } = await nestedProject();
    await writeFixture(root, "app/.clawpatch/run.json", "{}\n");
    await writeFixture(root, "sibling.txt", "unrelated change\n");
    expect(await hasSourceDirtyWorktree(project, state)).toBe(false);
    expect(await sourceChangedSnapshots(project, state)).toEqual(new Map());
  });

  it("fingerprints nested source contents relative to the selected project", async () => {
    const { root, project, state } = await nestedProject();
    await writeFixture(root, "app/src/index.ts", "export const value = 2;\n");
    const before = await sourceChangedSnapshots(project, state);
    await writeFixture(root, "app/src/index.ts", "export const value = 3;\n");
    const after = await sourceChangedSnapshots(project, state);
    expect(await hasSourceDirtyWorktree(project, state)).toBe(true);
    expect(changedPathsBetweenSnapshots(before, after)).toEqual(["src/index.ts"]);
  });

  it("records both sides of a staged rename using project-relative paths", async () => {
    const { project, state } = await nestedProject();
    const before = await sourceChangedSnapshots(project, state);
    const moved = await runCommandArgs("git", ["mv", "src/index.ts", "src/renamed.ts"], project);
    expect(moved.exitCode, moved.stderr).toBe(0);
    const after = await sourceChangedSnapshots(project, state);
    expect(changedPathsBetweenSnapshots(before, after)).toEqual(["src/index.ts", "src/renamed.ts"]);
  });
});
