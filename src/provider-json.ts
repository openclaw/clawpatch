import { ClawpatchError } from "./errors.js";

const MAX_FALLBACK_JSON_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_FALLBACK_JSON_DEPTH = 1_000;
const MAX_FALLBACK_JSON_CANDIDATES = 64;

export function extractJson(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {}
  if (Buffer.byteLength(text, "utf8") > MAX_FALLBACK_JSON_SCAN_BYTES) {
    return null;
  }
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/u);
  if (fenceMatch && fenceMatch[1]) {
    const candidate = fenceMatch[1].trim();
    try {
      return JSON.parse(candidate);
    } catch {}
  }
  let firstBrace = text.indexOf("{");
  let candidates = 0;
  while (firstBrace !== -1) {
    candidates += 1;
    if (candidates > MAX_FALLBACK_JSON_CANDIDATES) {
      return null;
    }
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = firstBrace; i < text.length; i += 1) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (ch === "{") {
          depth += 1;
          if (depth > MAX_FALLBACK_JSON_DEPTH) {
            return null;
          }
        } else if (ch === "}") {
          depth -= 1;
          if (depth === 0) {
            const candidate = text.slice(firstBrace, i + 1);
            try {
              return JSON.parse(candidate);
            } catch {
              firstBrace = text.indexOf("{", i + 1);
              break;
            }
          }
        }
      }
    }
    if (depth !== 0) {
      firstBrace = -1;
    }
  }
  return null;
}

export function parseCodexJson(raw: string): unknown {
  const parsed = extractJson(raw.trim());
  if (parsed !== null) {
    return parsed;
  }
  const preview = safeProviderPreview(raw);
  throw new ClawpatchError(
    `codex provider produced unparseable JSON output (preview: ${preview})`,
    8,
    "malformed-output",
  );
}

export function safeProviderPreview(value: string, maxLength = 200): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, maxLength);
}
