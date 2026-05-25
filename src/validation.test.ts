import { describe, expect, it } from "vitest";
import { validationCommandsForFeature } from "./validation.js";
import { FeatureRecord } from "./types.js";

const baseCommands = {
  typecheck: "mypy .",
  lint: "ruff check .",
  format: "ruff format --check .",
  test: "pytest",
};

const nativeCommands = {
  typecheck: null,
  lint: null,
  format: null,
  test: "ctest --preset default",
};

function feature(tags: string[]): FeatureRecord {
  return {
    schemaVersion: 1,
    featureId: "feat_test",
    title: "test",
    summary: "test",
    kind: "library",
    source: "cmake-bin",
    confidence: "high",
    entrypoints: [],
    ownedFiles: [],
    contextFiles: [],
    tests: [],
    tags,
    trustBoundaries: [],
    status: "pending",
    lock: null,
    findingIds: [],
    patchAttemptIds: [],
    analysisHistory: [],
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

describe("validationCommandsForFeature", () => {
  it("uses primary commands when no nativeCommands are configured", () => {
    expect(validationCommandsForFeature(feature(["python"]), baseCommands, null)).toEqual([
      "ruff format --check .",
      "mypy .",
      "ruff check .",
      "pytest",
    ]);
  });

  it("uses primary commands for features without a native language tag", () => {
    expect(validationCommandsForFeature(feature(["python"]), baseCommands, nativeCommands)).toEqual(
      ["ruff format --check .", "mypy .", "ruff check .", "pytest"],
    );
  });

  it("uses nativeCommands for cuda-tagged features when configured", () => {
    expect(validationCommandsForFeature(feature(["cuda"]), baseCommands, nativeCommands)).toEqual([
      "ctest --preset default",
    ]);
  });

  it("uses nativeCommands for cpp-tagged features when configured", () => {
    expect(
      validationCommandsForFeature(feature(["cpp", "library"]), baseCommands, nativeCommands),
    ).toEqual(["ctest --preset default"]);
  });

  it("uses nativeCommands for c-tagged features when configured", () => {
    expect(validationCommandsForFeature(feature(["c"]), baseCommands, nativeCommands)).toEqual([
      "ctest --preset default",
    ]);
  });

  it("falls back to primary commands for native features when nativeCommands is null", () => {
    expect(validationCommandsForFeature(feature(["cuda"]), baseCommands, null)).toEqual([
      "ruff format --check .",
      "mypy .",
      "ruff check .",
      "pytest",
    ]);
  });
});
