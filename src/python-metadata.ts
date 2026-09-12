import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathExists } from "./fs.js";

export async function pyprojectHasToolSection(root: string, tool: string): Promise<boolean> {
  if (!(await pathExists(join(root, "pyproject.toml")))) {
    return false;
  }
  const source = await readFile(join(root, "pyproject.toml"), "utf8");
  const escaped = tool.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^\\s*\\[\\[?tool\\.${escaped}(?:\\.|\\])`, "mu").test(source);
}

export function pythonTomlStringValues(source: string): string[] {
  const values: string[] = [];
  let quote: string | null = null;
  let value = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        value += char;
        escaped = false;
      } else if (char === "\\" && quote === '"') {
        escaped = true;
      } else if (char === quote) {
        values.push(value);
        quote = null;
        value = "";
      } else {
        value += char;
      }
      continue;
    }
    if (char === "#") {
      const nextNewline = source.indexOf("\n", index + 1);
      if (nextNewline === -1) {
        break;
      }
      index = nextNewline;
    } else if (char === '"' || char === "'") {
      quote = char;
      value = "";
    }
  }
  return values;
}

export function readTomlBracketValue(source: string, bracketIndex: number): string {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = bracketIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote !== null) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === "[") {
      depth += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(bracketIndex, index + 1);
      }
    }
  }
  return source.slice(bracketIndex);
}

export function pythonRequirementName(value: string): string | null {
  const trimmed = value.trim().replace(/^["']|["']$/gu, "");
  if (trimmed.length === 0 || trimmed.startsWith("#") || trimmed.startsWith("-")) {
    return null;
  }
  const match = /^([A-Za-z0-9_.-]+)/u.exec(trimmed);
  return match?.[1]?.toLowerCase().replace(/_/gu, "-") ?? null;
}
