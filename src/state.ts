import { open, readdir, unlink } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";
import { ClawpatchError } from "./errors.js";
import { ensureDir, nowIso, pathExists, readJson, writeJson } from "./fs.js";
import {
  FeatureRecord,
  FindingRecord,
  PatchAttempt,
  ProjectRecord,
  RunRecord,
  featureRecordSchema,
  featureLockSchema,
  findingRecordSchema,
  patchAttemptSchema,
  projectRecordSchema,
  runRecordSchema,
} from "./types.js";

export type StatePaths = {
  stateDir: string;
  config: string;
  project: string;
  features: string;
  findings: string;
  runs: string;
  patches: string;
  reports: string;
  locks: string;
};

type FeatureLock = NonNullable<FeatureRecord["lock"]>;

export type FeatureLockReclaimOptions = {
  hostname?: string;
  isPidAlive?: (pid: number) => boolean;
};

type ClaimFeatureOptions = {
  allowNonPending?: boolean;
  staleLock?: FeatureLockReclaimOptions;
};

export function statePaths(stateDir: string): StatePaths {
  return {
    stateDir,
    config: join(stateDir, "config.json"),
    project: join(stateDir, "project.json"),
    features: join(stateDir, "features"),
    findings: join(stateDir, "findings"),
    runs: join(stateDir, "runs"),
    patches: join(stateDir, "patches"),
    reports: join(stateDir, "reports"),
    locks: join(stateDir, "locks"),
  };
}

export async function ensureStateDirs(paths: StatePaths): Promise<void> {
  await Promise.all([
    ensureDir(paths.stateDir),
    ensureDir(paths.features),
    ensureDir(paths.findings),
    ensureDir(paths.runs),
    ensureDir(paths.patches),
    ensureDir(paths.reports),
    ensureDir(paths.locks),
  ]);
}

export async function readProject(paths: StatePaths): Promise<ProjectRecord | null> {
  if (!(await pathExists(paths.project))) {
    return null;
  }
  return readJson(paths.project, projectRecordSchema);
}

export async function writeProject(paths: StatePaths, project: ProjectRecord): Promise<void> {
  await writeJson(paths.project, project);
}

export async function readFeatures(paths: StatePaths): Promise<FeatureRecord[]> {
  return readRecords(paths.features, featureRecordSchema);
}

export async function readFeature(paths: StatePaths, id: string): Promise<FeatureRecord | null> {
  const path = featurePath(paths, id);
  if (!(await pathExists(path))) {
    return null;
  }
  return readJson(path, featureRecordSchema);
}

export async function writeFeature(paths: StatePaths, feature: FeatureRecord): Promise<void> {
  await writeJson(featurePath(paths, feature.featureId), feature);
}

export async function claimFeature(
  paths: StatePaths,
  featureId: string,
  lock: FeatureLock,
  options: ClaimFeatureOptions = {},
): Promise<FeatureRecord> {
  await ensureDir(paths.locks);
  return withFeatureLockMutation(paths, featureId, () =>
    claimFeatureUnderMutationLock(paths, featureId, lock, options),
  );
}

async function claimFeatureUnderMutationLock(
  paths: StatePaths,
  featureId: string,
  lock: FeatureLock,
  options: ClaimFeatureOptions,
): Promise<FeatureRecord> {
  const lockPath = featureLockPath(paths, featureId);
  let lockFileCreated = false;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, "wx");
      await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
      lockFileCreated = true;
      break;
    } catch (error: unknown) {
      if (isNodeError(error, "EEXIST")) {
        if (attempt === 0 && (await reclaimStaleFeatureLock(paths, featureId, options.staleLock))) {
          continue;
        }
        throw new ClawpatchError(`feature locked: ${featureId}`, 7, "lock-conflict");
      }
      if (handle !== undefined) {
        await handle.close();
        handle = undefined;
        await releaseFeatureLock(paths, featureId);
      }
      throw error;
    } finally {
      await handle?.close();
    }
  }
  if (!lockFileCreated) {
    throw new ClawpatchError(`feature locked: ${featureId}`, 7, "lock-conflict");
  }

  try {
    let feature = await readFeature(paths, featureId);
    if (feature === null) {
      throw new ClawpatchError(`feature not found: ${featureId}`, 2, "feature-not-found");
    }
    if (feature.lock !== null && isStaleLocalFeatureLock(feature.lock, options.staleLock)) {
      feature = clearFeatureRecordLock(feature);
      await writeFeature(paths, feature);
    }
    if (feature.lock !== null) {
      throw new ClawpatchError(`feature locked: ${featureId}`, 7, "lock-conflict");
    }
    if (options.allowNonPending !== true && !["pending", "error"].includes(feature.status)) {
      throw new ClawpatchError(`feature not reviewable: ${featureId}`, 7, "lock-conflict");
    }
    const claimed: FeatureRecord = {
      ...feature,
      status: "claimed",
      lock,
      updatedAt: nowIso(),
    };
    await writeFeature(paths, claimed);
    return claimed;
  } catch (error: unknown) {
    await releaseFeatureLock(paths, featureId);
    throw error;
  }
}

export async function releaseFeatureLock(paths: StatePaths, featureId: string): Promise<void> {
  await deleteFeatureLockFile(paths, featureId);
}

async function deleteFeatureLockFile(paths: StatePaths, featureId: string): Promise<boolean> {
  try {
    await unlink(featureLockPath(paths, featureId));
    return true;
  } catch (error: unknown) {
    if (!isNodeError(error, "ENOENT")) {
      throw error;
    }
    return false;
  }
}

export async function clearFeatureLockFiles(paths: StatePaths): Promise<number> {
  const lockIds = await readFeatureLockIds(paths);
  for (const id of lockIds) {
    await releaseFeatureLock(paths, id);
  }
  return lockIds.length;
}

export async function clearStaleFeatureLocks(
  paths: StatePaths,
  options: FeatureLockReclaimOptions = {},
): Promise<{ featuresCleared: number; lockFilesCleared: number }> {
  const features = await readFeatures(paths);
  const featureIds = new Set([
    ...features.map((feature) => feature.featureId),
    ...(await readFeatureLockIds(paths)),
  ]);
  let featuresCleared = 0;
  let lockFilesCleared = 0;
  for (const featureId of featureIds) {
    const cleared = await withFeatureLockMutation(paths, featureId, () =>
      clearStaleFeatureLockUnderMutationLock(paths, featureId, options),
    );
    featuresCleared += cleared.featureCleared ? 1 : 0;
    lockFilesCleared += cleared.lockFileCleared ? 1 : 0;
  }
  return { featuresCleared, lockFilesCleared };
}

export async function readFeatureLockIds(paths: StatePaths): Promise<string[]> {
  if (!(await pathExists(paths.locks))) {
    return [];
  }
  const names = await readdir(paths.locks);
  return names
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.slice(0, -".json".length))
    .toSorted();
}

export async function readFindings(paths: StatePaths): Promise<FindingRecord[]> {
  return readRecords(paths.findings, findingRecordSchema);
}

export async function readFinding(paths: StatePaths, id: string): Promise<FindingRecord | null> {
  const path = recordPath(paths.findings, id);
  if (!(await pathExists(path))) {
    return null;
  }
  return readJson(path, findingRecordSchema);
}

export async function writeFinding(paths: StatePaths, finding: FindingRecord): Promise<void> {
  await writeJson(recordPath(paths.findings, finding.findingId), finding);
}

export async function writeRun(paths: StatePaths, run: RunRecord): Promise<void> {
  await writeJson(recordPath(paths.runs, run.runId), run);
}

export async function readRuns(paths: StatePaths): Promise<RunRecord[]> {
  return readRecords(paths.runs, runRecordSchema);
}

export async function writePatchAttempt(paths: StatePaths, patch: PatchAttempt): Promise<void> {
  await writeJson(recordPath(paths.patches, patch.patchAttemptId), patch);
}

export async function readPatchAttempts(paths: StatePaths): Promise<PatchAttempt[]> {
  return readRecords(paths.patches, patchAttemptSchema);
}

async function readRecords<T>(dir: string, schema: z.ZodType<T>): Promise<T[]> {
  if (!(await pathExists(dir))) {
    return [];
  }
  const names = await readdir(dir);
  const records: T[] = [];
  for (const name of names.toSorted()) {
    if (!name.endsWith(".json")) {
      continue;
    }
    records.push(await readJson(join(dir, name), schema));
  }
  return records;
}

function featurePath(paths: StatePaths, featureId: string): string {
  return recordPath(paths.features, featureId);
}

function featureLockPath(paths: StatePaths, featureId: string): string {
  return recordPath(paths.locks, featureId);
}

function recordPath(directory: string, id: string): string {
  if (id.length === 0 || id === "." || id === ".." || /[\\/]/u.test(id) || id.includes("\0")) {
    throw new ClawpatchError(`invalid record id: ${id}`, 2, "invalid-input");
  }
  return join(directory, `${id}.json`);
}

async function reclaimStaleFeatureLock(
  paths: StatePaths,
  featureId: string,
  options: FeatureLockReclaimOptions = {},
): Promise<boolean> {
  const [feature, fileLock] = await Promise.all([
    readFeature(paths, featureId),
    readFeatureLockFile(paths, featureId),
  ]);
  const featureLock = feature?.lock ?? null;
  if (featureLock === null && fileLock === null) {
    return false;
  }
  if (featureLock !== null && !isStaleLocalFeatureLock(featureLock, options)) {
    return false;
  }
  if (fileLock !== null && !isStaleLocalFeatureLock(fileLock, options)) {
    return false;
  }
  if (featureLock !== null && feature !== null) {
    await writeFeature(paths, clearFeatureRecordLock(feature));
  }
  if (fileLock !== null) {
    await deleteFeatureLockFile(paths, featureId);
  }
  return true;
}

async function clearStaleFeatureLockUnderMutationLock(
  paths: StatePaths,
  featureId: string,
  options: FeatureLockReclaimOptions,
): Promise<{ featureCleared: boolean; lockFileCleared: boolean }> {
  const [feature, fileLock] = await Promise.all([
    readFeature(paths, featureId),
    readFeatureLockFile(paths, featureId),
  ]);
  const featureLock = feature?.lock ?? null;
  if (featureLock !== null && !isStaleLocalFeatureLock(featureLock, options)) {
    return { featureCleared: false, lockFileCleared: false };
  }
  if (fileLock !== null && !isStaleLocalFeatureLock(fileLock, options)) {
    return { featureCleared: false, lockFileCleared: false };
  }
  if (featureLock !== null && feature !== null) {
    await writeFeature(paths, clearFeatureRecordLock(feature));
  }
  const lockFileCleared = fileLock !== null && (await deleteFeatureLockFile(paths, featureId));
  return { featureCleared: featureLock !== null, lockFileCleared };
}

async function withFeatureLockMutation<T>(
  paths: StatePaths,
  featureId: string,
  operation: () => Promise<T>,
): Promise<T> {
  await ensureDir(paths.locks);
  const target = featureLockPath(paths, featureId);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(target, {
      realpath: false,
      stale: 5_000,
      update: 1_000,
      retries: { retries: 10, factor: 1.5, minTimeout: 10, maxTimeout: 100 },
    });
  } catch (error: unknown) {
    if (isNodeError(error, "ELOCKED")) {
      throw new ClawpatchError(`feature locked: ${featureId}`, 7, "lock-conflict");
    }
    throw error;
  }
  try {
    return await operation();
  } finally {
    await release();
  }
}

function clearFeatureRecordLock(feature: FeatureRecord): FeatureRecord {
  return {
    ...feature,
    status: feature.status === "claimed" ? "pending" : feature.status,
    lock: null,
    updatedAt: nowIso(),
  };
}

async function readFeatureLockFile(
  paths: StatePaths,
  featureId: string,
): Promise<FeatureLock | null> {
  try {
    return await readJson(featureLockPath(paths, featureId), featureLockSchema);
  } catch {
    return null;
  }
}

export function isStaleLocalFeatureLock(
  lock: FeatureLock,
  options: FeatureLockReclaimOptions = {},
): boolean {
  const currentHostname = options.hostname ?? osHostname();
  const isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
  return lock.hostname === currentHostname && !isPidAlive(lock.pid);
}

function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error, "ESRCH")) {
      return false;
    }
    return true;
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
