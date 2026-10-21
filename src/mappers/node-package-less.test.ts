import { symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectProject } from "../detect.js";
import { mapFeatures } from "../mapper.js";
import { fixtureRoot, writeFixture } from "../test-helpers.js";
import type { FeatureRecord } from "../types.js";

function owners(features: FeatureRecord[], path: string): FeatureRecord[] {
  return features.filter((feature) => feature.ownedFiles.some((file) => file.path === path));
}

describe("package-less nested Node sources", () => {
  it.each([true, false])(
    "maps the reproduction once with workspace metadata: %s",
    async (workspace) => {
      const root = await fixtureRoot("clawpatch-nested-package-less-");
      if (workspace) {
        await writeFixture(
          root,
          "package.json",
          '{"name":"portable-mapping-fixture","private":true,"type":"module"}\n',
        );
        await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
      }
      const path = "packages/core/governance/types.ts";
      await writeFixture(root, path, "export type Policy = { enabled: boolean };\n");
      const project = await detectProject(root);
      const first = await mapFeatures(root, project, []);
      expect(owners(first.features, path)).toHaveLength(1);
      expect(owners(first.features, path)[0]?.tags).toContain("project-root:packages/core");
      const second = await mapFeatures(root, project, first.features);
      expect(second.created).toBe(0);
      expect(second.changed).toBe(0);
      expect(second.features.map((feature) => feature.featureId)).toEqual(
        first.features.map((feature) => feature.featureId),
      );
    },
  );

  it("keeps conventional sources and explicit nested project owners", async () => {
    const root = await fixtureRoot("clawpatch-nested-owners-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/**'\n");
    await writeFixture(root, "packages/core/src/index.ts", "export const core = true;\n");
    await writeFixture(
      root,
      "packages/core/governance/types.ts",
      "export type Policy = boolean;\n",
    );
    await writeFixture(
      root,
      "packages/core/governance/types.test.ts",
      "test('policy', () => {});\n",
    );
    await writeFixture(
      root,
      "packages/core/governance/nested/project.json",
      JSON.stringify({
        name: "explicit-policy",
        sourceRoot: "packages/core/governance/nested/implementation",
        targets: { test: {} },
      }),
    );
    await writeFixture(
      root,
      "packages/core/governance/nested/implementation/policy.ts",
      "export const policy = true;\n",
    );
    await writeFixture(
      root,
      "packages/core/governance/nested/outside.ts",
      "export const outside = true;\n",
    );
    await writeFixture(root, "packages/core/child/package.json", '{"name":"child"}\n');
    await writeFixture(root, "packages/core/child/src/child.ts", "export const child = true;\n");
    const result = await mapFeatures(root, await detectProject(root), []);
    for (const path of [
      "packages/core/src/index.ts",
      "packages/core/governance/types.ts",
      "packages/core/governance/nested/implementation/policy.ts",
      "packages/core/child/src/child.ts",
    ]) {
      expect(owners(result.features, path), path).toHaveLength(1);
    }
    expect(
      owners(result.features, "packages/core/governance/nested/implementation/policy.ts")[0]?.tags,
    ).toContain("project:explicit-policy");
    expect(owners(result.features, "packages/core/governance/nested/outside.ts")).toHaveLength(0);
    expect(owners(result.features, "packages/core/governance/types.ts")[0]?.tests).toContainEqual({
      path: "packages/core/governance/types.test.ts",
      command: null,
    });
  });

  it("respects configured and workspace excludes, generated files, and symlinks", async () => {
    const root = await fixtureRoot("clawpatch-nested-excludes-");
    await writeFixture(
      root,
      "pnpm-workspace.yaml",
      "packages:\n  - 'packages/*'\n  - '!packages/ignored'\n  - '!packages/core/excluded'\n",
    );
    const source = "packages/core/governance/types.ts";
    await writeFixture(root, source, "export type Policy = boolean;\n");
    const ignored = [
      "packages/ignored/governance/types.ts",
      "packages/core/private/secret.ts",
      "packages/core/excluded/policy.ts",
      "packages/core/dist/output.ts",
      "packages/core/node_modules/dependency/index.ts",
      "packages/core/generated/types.ts",
      "packages/core/governance/types.generated.ts",
      "packages/core/fixtures/sample.ts",
      "packages/core/governance/types.d.ts",
      "packages/core/governance/types.test.ts",
    ];
    for (const path of ignored) await writeFixture(root, path, "export const ignored = true;\n");
    if (process.platform !== "win32") {
      await symlink(
        join(root, "packages/core/governance"),
        join(root, "packages/core/linked"),
        "dir",
      );
      await symlink(join(root, source), join(root, "packages/core/link.ts"));
    }
    const result = await mapFeatures(root, await detectProject(root), [], {
      filters: { include: ["**/*"], exclude: ["packages/core/private/**"] },
    });
    expect(owners(result.features, source)).toHaveLength(1);
    for (const path of [...ignored, "packages/core/linked/types.ts", "packages/core/link.ts"])
      expect(owners(result.features, path), path).toHaveLength(0);
  });

  it("bounds source groups and leaves package manifests authoritative", async () => {
    const root = await fixtureRoot("clawpatch-nested-bounds-");
    const paths = Array.from(
      { length: 29 },
      (_, index) => `packages/core/governance/policy${index}.ts`,
    );
    for (const path of paths) await writeFixture(root, path, "export const policy = true;\n");
    await writeFixture(root, "packages/explicit/package.json", '{"name":"explicit"}\n');
    await writeFixture(
      root,
      "packages/explicit/governance/types.ts",
      "export type Policy = boolean;\n",
    );
    const result = await mapFeatures(root, await detectProject(root), []);
    for (const path of paths) expect(owners(result.features, path), path).toHaveLength(1);
    expect(
      result.features.every(
        (feature) => feature.source !== "node-source-group" || feature.ownedFiles.length <= 12,
      ),
    ).toBe(true);
    expect(owners(result.features, "packages/explicit/governance/types.ts")).toHaveLength(0);
  });

  it("respects nested manifests outside the default workspace discovery scope", async () => {
    const root = await fixtureRoot("clawpatch-nested-manifest-boundary-");
    await writeFixture(root, "pnpm-workspace.yaml", "packages:\n  - 'packages/*'\n");
    const path = "packages/core/governance/types.ts";
    await writeFixture(root, path, "export type Policy = boolean;\n");
    await writeFixture(root, "packages/core/child/package.json", '{"name":"child"}\n');
    await writeFixture(
      root,
      "packages/core/child/governance/types.ts",
      "export type Child = boolean;\n",
    );
    await writeFixture(
      root,
      "packages/core/scripts/child/package.json",
      '{"name":"script-child"}\n',
    );
    await writeFixture(
      root,
      "packages/core/scripts/child/src/index.ts",
      "export const child = true;\n",
    );
    await writeFixture(root, "packages/core/src/child/package.json", '{"name":"source-child"}\n');
    await writeFixture(root, "packages/core/src/child/index.ts", "export const child = true;\n");
    const result = await mapFeatures(root, await detectProject(root), []);
    expect(owners(result.features, path)).toHaveLength(1);
    expect(owners(result.features, "packages/core/child/governance/types.ts")).toHaveLength(0);
    expect(owners(result.features, "packages/core/scripts/child/src/index.ts")).toHaveLength(0);
    expect(owners(result.features, "packages/core/src/child/index.ts")).toHaveLength(0);
  });
});
