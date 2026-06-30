import { z } from "zod";
import {
  agentMapOutputSchema,
  fixPlanOutputSchema,
  reviewOutputSchema,
  revalidateOutputSchema,
} from "./types.js";

const providerUnsupportedJsonSchemaKeywords = new Set([
  "$schema",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
  "multipleOf",
]);

export const agentMapJsonSchema = providerJsonSchema(agentMapOutputSchema);
export const reviewJsonSchema = providerJsonSchema(reviewOutputSchema);
export const revalidateJsonSchema = providerJsonSchema(revalidateOutputSchema);
export const fixPlanJsonSchema = providerJsonSchema(fixPlanOutputSchema);

export function providerJsonSchema(schema: z.ZodType): object {
  return stripProviderUnsupportedSchemaKeywords(
    z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }),
  ) as object;
}

function stripProviderUnsupportedSchemaKeywords(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripProviderUnsupportedSchemaKeywords);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (providerUnsupportedJsonSchemaKeywords.has(key)) {
      continue;
    }
    output[key] = stripProviderUnsupportedSchemaKeywords(item);
  }
  const nullableType = nullableAnyOfType(output["anyOf"]);
  if (nullableType !== null && Object.keys(output).length === 1) {
    output["type"] = [nullableType, "null"];
    delete output["anyOf"];
  }
  if (output["type"] === "object" && isRecord(output["properties"])) {
    output["additionalProperties"] = false;
    output["required"] = Object.keys(output["properties"]);
  }
  return output;
}

function nullableAnyOfType(value: unknown): string | null {
  if (!Array.isArray(value) || value.length !== 2) {
    return null;
  }
  const typeSchemas = value.filter(isSingleTypeSchema);
  const nullable = typeSchemas.find((schema) => schema["type"] === "null");
  const typed = typeSchemas.find((schema) => schema["type"] !== "null");
  return typeSchemas.length === 2 && nullable !== undefined && typeof typed?.["type"] === "string"
    ? typed["type"]
    : null;
}

function isSingleTypeSchema(value: unknown): value is { type: string } {
  return isRecord(value) && typeof value["type"] === "string" && Object.keys(value).length === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
