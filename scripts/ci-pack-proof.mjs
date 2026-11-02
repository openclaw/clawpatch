import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

const expected = {
  baseline: "79c1495f20d33b68ca4439dfa9dfef18ed7a460e",
  candidate: "f3505124159b5bfbb5ad6605f95e1e400b3cb441",
};
const workspace = process.env.GITHUB_WORKSPACE;
const variant = process.env.PROOF_VARIANT;
const phase = process.env.PROOF_PHASE;
const source = resolve(workspace, "source");
const results = { variant, phase, expected, measurements: [], controls: [] };

function command(root, program, args, success = true) {
  const start = performance.now();
  const result = spawnSync(program, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180000,
  });
  assert.ifError(result.error);
  if (success && result.status !== 0) {
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(`${program} ${args.join(" ")} exited ${result.status}`);
  }
  return {
    ms: performance.now() - start,
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
  };
}

function qualify(root, label) {
  assert.equal(command(root, "git", ["rev-parse", "HEAD"]).output.trim(), expected[label]);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  assert.equal((workflow.match(/- run: pnpm build\n/g) ?? []).length, label === "baseline" ? 2 : 0);
  assert.equal((workflow.match(/- run: pnpm pack:smoke\n/g) ?? []).length, 2);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts.prepack, "pnpm run build");
  assert.equal(pkg.scripts["pack:smoke"], "node scripts/package-smoke.mjs");
}

function digest(root) {
  const directory = join(root, "dist");
  assert.ok(existsSync(join(directory, "cli.js")));
  const files = readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(directory.length + 1))
    .sort();
  const hash = createHash("sha256");
  for (const file of files)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(join(directory, file)));
  return { files: files.length, sha256: hash.digest("hex") };
}

function pipeline(root, label, success = true) {
  return command(
    root,
    "bash",
    [
      "-euo",
      "pipefail",
      "-c",
      label === "baseline" ? "pnpm build && pnpm pack:smoke" : "pnpm pack:smoke",
    ],
    success,
  );
}

function measure(root, label, sample) {
  rmSync(join(root, "dist"), { recursive: true, force: true });
  assert.equal(existsSync(join(root, "dist")), false);
  const result = pipeline(root, label);
  const output = digest(root);
  results.measurements.push({ label, sample, ms: result.ms, ...output });
}

qualify(source, variant);
assert.equal(existsSync(join(source, "node_modules")), false);
assert.equal(existsSync(join(source, "dist")), false);
results.versions = {
  node: process.version,
  pnpm: command(source, "pnpm", ["--version"]).output.trim(),
  npm: command(source, "npm", ["--version"]).output.trim(),
};
results.installMs = command(source, "pnpm", ["install", "--frozen-lockfile"]).ms;
measure(source, variant, phase);

if (variant === "candidate" && phase === "restored") {
  const baseline = resolve(workspace, "baseline");
  qualify(baseline, "baseline");
  assert.equal(existsSync(join(baseline, "node_modules")), false);
  results.hotBaselineInstallMs = command(baseline, "pnpm", ["install", "--frozen-lockfile"]).ms;
  for (let repeat = 0; repeat < 3; repeat += 1) {
    const order = repeat % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    for (const label of order)
      measure(label === "baseline" ? baseline : source, label, `hot-${repeat + 1}`);
  }
  assert.equal(new Set(results.measurements.map((entry) => entry.sha256)).size, 1);
  for (const label of ["baseline", "candidate"]) {
    const root = label === "baseline" ? baseline : source;
    const invalidSource = join(root, "src/ci-proof-invalid.ts");
    assert.equal(existsSync(invalidSource), false);
    try {
      writeFileSync(invalidSource, "const invalidProof: string = 42;\nexport { invalidProof };\n");
      const invalid = pipeline(root, label, false);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.output, /TS2322/);
      results.controls.push({ label, control: "invalid TypeScript", rejected: true });
    } finally {
      rmSync(invalidSource);
    }
    const packagePath = join(root, "package.json");
    const original = readFileSync(packagePath, "utf8");
    try {
      const pkg = JSON.parse(original);
      pkg.scripts.prepack = 'node -e "process.exit(23)"';
      writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
      const invalid = pipeline(root, label, false);
      assert.notEqual(invalid.status, 0);
      assert.match(invalid.output, /process.exit\(23\)/);
      results.controls.push({ label, control: "failing prepack hook", rejected: true });
    } finally {
      writeFileSync(packagePath, original);
    }
  }
}

console.log(`PROOF_JSON=${JSON.stringify(results)}`);
appendFileSync(
  process.env.GITHUB_STEP_SUMMARY,
  `\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\`\n`,
);
