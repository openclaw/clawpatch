import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

type PackageSmokeTesting = {
  packageSmokeTestHooks: {
    installArgs(input: {
      installRoot: string;
      npmCache: string;
      tarball: string;
      dependencyTarballs: string[];
    }): string[];
    packDependencyArgs(input: {
      dependencyPath: string;
      destination: string;
      npmCache: string;
    }): string[];
    runtimeDependencyNames(packageJson: { dependencies?: Record<string, string> }): string[];
  };
};

async function packageSmokeTesting(): Promise<PackageSmokeTesting["packageSmokeTestHooks"]> {
  const moduleUrl = pathToFileURL(join(process.cwd(), "scripts/package-smoke.mjs")).href;
  const smoke = (await import(moduleUrl)) as PackageSmokeTesting;
  return smoke.packageSmokeTestHooks;
}

describe("package smoke harness", () => {
  it("installs the packed clawpatch artifact with packed runtime dependencies", async () => {
    const smoke = await packageSmokeTesting();
    const dependencySource = "/repo/node_modules/.pnpm/zod@4.4.3/node_modules/zod";
    const clawpatchTarball = "/tmp/clawpatch-0.5.1.tgz";
    const dependencyTarball = "/tmp/zod-4.4.3.tgz";

    const dependencyNames = smoke.runtimeDependencyNames({
      dependencies: { zod: "^4.4.3" },
    });
    expect(dependencyNames).toEqual(["zod"]);

    const packArgs = smoke.packDependencyArgs({
      dependencyPath: dependencySource,
      destination: "/tmp",
      npmCache: "/tmp/cache",
    });
    expect(packArgs).toEqual([
      "--dir",
      dependencySource,
      "--config.ignore-scripts=true",
      "pack",
      "--json",
      "--pack-destination",
      "/tmp",
    ]);

    const installArgs = smoke.installArgs({
      installRoot: "/tmp/install",
      npmCache: "/tmp/cache",
      tarball: clawpatchTarball,
      dependencyTarballs: [dependencyTarball],
    });
    expect(installArgs).toEqual([
      "install",
      "--offline",
      "--omit=dev",
      "--cache",
      "/tmp/cache",
      "--prefix",
      "/tmp/install",
      clawpatchTarball,
      dependencyTarball,
    ]);
    expect(installArgs).not.toContain(dependencySource);
  });
});
