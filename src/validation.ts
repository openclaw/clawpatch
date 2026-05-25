import { suppressedTestCommandTag } from "./mappers/types.js";
import { FeatureRecord } from "./types.js";

export type ValidationCommandConfig = {
  typecheck: string | null;
  lint: string | null;
  format: string | null;
  test: string | null;
};

const nativeFeatureTags = new Set(["c", "cpp", "cuda"]);

export function validationCommandsForFeature(
  feature: FeatureRecord | null,
  commands: ValidationCommandConfig,
  nativeCommands: ValidationCommandConfig | null = null,
): string[] {
  const effective = nativeCommands !== null && featureIsNative(feature) ? nativeCommands : commands;
  const featureCommands = (feature?.tests ?? []).flatMap((test) =>
    test.command === null || test.command.length === 0 ? [] : [test.command],
  );
  const configuredTest =
    feature?.tags.includes(suppressedTestCommandTag) === true ? null : effective.test;
  const ordered = [
    effective.format,
    ...featureCommands,
    effective.typecheck,
    effective.lint,
    configuredTest,
  ].filter((command): command is string => command !== null && command.length > 0);
  return Array.from(new Set(ordered));
}

function featureIsNative(feature: FeatureRecord | null): boolean {
  return feature?.tags.some((tag) => nativeFeatureTags.has(tag)) === true;
}
