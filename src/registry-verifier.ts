// Refute only direct public-npm publication claims; uncertain registry results keep findings.
const NPM_REGISTRY_BASE = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 5_000;
const RESPONSE_BODY_BYTE_CAP = 1_048_576; // 1 MiB; per-version manifests are ~1-3 KB
const USER_AGENT = "clawpatch (+https://github.com/openclaw/clawpatch)";

// Match complete lowercase package@semver tokens, excluding tags and sentence punctuation.
const SPEC_PATTERN =
  /(?<![A-Za-z0-9_/-])(@?[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)?)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)(?!\.\d|[A-Za-z0-9-])/gu;

export type RegistryVerdict =
  | { kind: "verified-published"; name: string; version: string }
  | { kind: "verified-missing"; name: string; version: string }
  | { kind: "unknown"; name: string; version: string; reason: string };

export type PackageSpec = { name: string; version: string };

export type RegistryVerifierOptions = {
  /**
   * Per-instance cache of `(name, version) → verdict`. Stores in-flight
   * promises so concurrent verifications of the same spec deduplicate
   * onto a single network request (no thundering herd when `--jobs N`
   * has multiple feature reviews citing the same package). Provide a
   * shared `Map` to extend the cache across runs.
   */
  cache?: Map<string, Promise<RegistryVerdict>>;
  /** Override `globalThis.fetch` (testing, custom transport). */
  fetchImpl?: typeof fetch;
  /** Wall-clock timeout per request. Default 5s. */
  timeoutMs?: number;
  /** Override registry base URL. Default `https://registry.npmjs.org`. */
  registryBase?: string;
  /**
   * Optional caller-supplied AbortSignal (e.g. wired to user Ctrl-C).
   * Combined with the per-request timeout signal so either source can
   * cancel. Aborted requests resolve to `kind: "unknown"`.
   */
  signal?: AbortSignal;
};

/**
 * Returns true only for a narrow direct package-publication claim. The
 * verifier intentionally prefers false negatives over dropping a finding
 * whose wider title may describe documentation, lockfile, cache, or private
 * registry behavior.
 */
export function findingClaimsNonexistence(title: string): boolean {
  const specs = extractPackageSpecs(title);
  if (specs.length !== 1) {
    return false;
  }
  const firstSpec = specs[0]!;
  const specText = `${firstSpec.name}@${firstSpec.version}`;
  const trimmed = title.trimStart();
  const specIndex = trimmed.indexOf(specText);
  const prefix = specIndex < 0 ? "" : trimmed.slice(0, specIndex).trim();
  if (specIndex < 0 || !/^(?:package|pinned|dependency|version)?$/iu.test(prefix)) {
    return false;
  }
  const claim = trimmed.slice(specIndex + specText.length);
  return (
    /^\s+(?:is\s+)?(?:unpublished|not published|not a published version|non[- ]?existent|does ?n'?t exist|does not exist)\s+(?:on|in)\s+(?:public\s+)?npm\s*[.!?]?$/iu.test(
      claim,
    ) ||
    /^\s+(?:is\s+)?(?:unpublished|not published|non[- ]?existent|does ?n'?t exist|does not exist)\s+(?:at|on)\s+(?:https?:\/\/)?registry\.npmjs\.org\s*[.!?]?$/iu.test(
      claim,
    ) ||
    /^\s+(?:has\s+)?(?:ETARGET|no matching version)(?:\s+(?:error|response))?\s+(?:on|from)\s+(?:public\s+)?npm\s*[.!?]?$/iu.test(
      claim,
    )
  );
}

/**
 * Extract candidate `pkg@version` specs from the union of a finding's
 * narrative fields. Returns deduplicated specs in document order.
 *
 * The extractor is conservative: it only matches tokens that look like
 * complete semver-shaped specs. Loose phrasing like "mongodb 7" or
 * "version 7.0" is not extracted — verification of an under-specified
 * claim could not be reliable.
 */
export function extractPackageSpecs(text: string): PackageSpec[] {
  const seen = new Set<string>();
  const specs: PackageSpec[] = [];
  for (const match of text.matchAll(SPEC_PATTERN)) {
    const name = match[1]!;
    const version = match[2]!;
    const key = `${name}@${version}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    specs.push({ name, version });
  }
  return specs;
}

/**
 * Resolve a single `(name, version)` spec against the npm registry.
 * Uses the per-version document endpoint (`/{name}/{version}`) to avoid
 * downloading the full packument when only an existence check is needed.
 *
 * The endpoint contract:
 *   200 with JSON body whose `name` AND `version` match → published
 *   404                                                  → not published
 *   anything else / transport failure / redirect / mismatched body → unknown
 *
 * Defensive against intercepting proxies and misconfigured mirrors:
 *   - `redirect: "error"` so a 302 to an SSO gate becomes "unknown",
 *     not a successful drop;
 *   - response Content-Type must contain `application/json`;
 *   - response body capped at 1 MiB to prevent hostile mirrors from
 *     exhausting memory inside the timeout window;
 *   - both `name` and `version` of the response body must match the
 *     requested spec (a mirror that returns `{version:"X"}` for any
 *     path is otherwise indistinguishable from a real publish).
 */
export async function verifyPackageSpec(
  spec: PackageSpec,
  options: RegistryVerifierOptions = {},
): Promise<RegistryVerdict> {
  const cache = options.cache;
  const cacheKey = `${spec.name}@${spec.version}`;
  if (cache) {
    const inflight = cache.get(cacheKey);
    if (inflight) {
      return inflight;
    }
  }
  // Wrap rejections defensively: every code path in `resolveVerdict`
  // already returns a verdict, but a future refactor or a rogue
  // `fetchImpl` that throws a non-Error (e.g. a Symbol or null) would
  // otherwise poison the cache with a permanently-rejected promise.
  const verdictPromise = resolveVerdict(spec, options).catch((error: unknown): RegistryVerdict =>
    unknownVerdict(
      spec,
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    ),
  );
  if (cache) {
    cache.set(cacheKey, verdictPromise);
  }
  return verdictPromise;
}

async function resolveVerdict(
  spec: PackageSpec,
  options: RegistryVerifierOptions,
): Promise<RegistryVerdict> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const base = options.registryBase ?? NPM_REGISTRY_BASE;
  const url = `${base}/${encodeURIComponent(spec.name)}/${encodeURIComponent(spec.version)}`;
  const timeoutController = new AbortController();
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const timer = setTimeout(
    () => timeoutController.abort(new DOMException(`timeout ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  timer.unref();
  const signal = options.signal
    ? AbortSignal.any([timeoutController.signal, options.signal])
    : timeoutController.signal;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal,
      redirect: "error",
    });
    if (response.status === 404) {
      return { kind: "verified-missing", name: spec.name, version: spec.version };
    }
    if (response.status !== 200) {
      return unknownVerdict(spec, `registry returned status ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return unknownVerdict(
        spec,
        `registry returned 200 with non-JSON content-type: ${contentType || "<missing>"}`,
      );
    }
    const text = await readCappedText(response, RESPONSE_BODY_BYTE_CAP);
    if (text === null) {
      return unknownVerdict(
        spec,
        `registry response body exceeded ${RESPONSE_BODY_BYTE_CAP} bytes`,
      );
    }
    const body = safeJsonParse(text);
    if (
      body &&
      typeof body["version"] === "string" &&
      body["version"] === spec.version &&
      typeof body["name"] === "string" &&
      body["name"] === spec.name
    ) {
      return { kind: "verified-published", name: spec.name, version: spec.version };
    }
    return unknownVerdict(
      spec,
      "registry returned 200 but body did not match expected name/version",
    );
  } catch (error: unknown) {
    if (error instanceof Error && error.name === "AbortError") {
      const reason = timeoutController.signal.aborted
        ? `request timed out after ${timeoutMs}ms`
        : "request aborted by caller signal";
      return unknownVerdict(spec, reason);
    }
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return unknownVerdict(spec, reason);
  } finally {
    clearTimeout(timer);
  }
}

function unknownVerdict(spec: PackageSpec, reason: string): RegistryVerdict {
  return { kind: "unknown", name: spec.name, version: spec.version, reason };
}

function safeJsonParse(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Read the response body up to `cap` bytes; return null if the limit is
 * exceeded. Uses the underlying ReadableStream so a hostile slow-trickle
 * body trips the cap before it trips the wall-clock timeout, and the
 * stream is cancelled (closing the underlying connection) instead of
 * being released-and-drained.
 *
 * When the response has no readable body (some 204/304 paths, or
 * runtime quirks) we cannot enforce the cap by streaming. If the
 * `Content-Length` header is missing in that case, we conservatively
 * report cap-exceeded rather than calling `response.text()` (which has
 * no upper bound).
 */
async function readCappedText(response: Response, cap: number): Promise<string | null> {
  const headerLength = response.headers.get("content-length");
  const contentLength = headerLength === null ? null : Number(headerLength);
  if (contentLength !== null && Number.isFinite(contentLength) && contentLength > cap) {
    return null;
  }
  if (!response.body) {
    if (contentLength === null) {
      return null;
    }
    return response.text();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > cap) {
        exceeded = true;
        break;
      }
      chunks.push(value);
    }
  } finally {
    if (exceeded) {
      // Cancel propagates upstream and closes the underlying connection
      // so a slow-trickle body doesn't keep transferring after we bail.
      // releaseLock on its own only detaches the reader.
      await reader.cancel("body cap exceeded").catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
  if (exceeded) {
    return null;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

// Title and reasoning must make the same single-package claim before any registry request.
export async function evaluateFindingForDrop(
  finding: { title: string; reasoning: string; recommendation: string },
  options: RegistryVerifierOptions = {},
): Promise<{ dropReason: string; spec: PackageSpec } | null> {
  if (!findingClaimsNonexistence(finding.title) || !findingClaimsNonexistence(finding.reasoning)) {
    return null;
  }
  const spec = extractPackageSpecs(finding.title)[0]!;
  const reasoningSpec = extractPackageSpecs(finding.reasoning)[0]!;
  if (reasoningSpec.name !== spec.name || reasoningSpec.version !== spec.version) {
    return null;
  }
  const verdict = await verifyPackageSpec(spec, options);
  if (verdict.kind !== "verified-published") {
    return null;
  }
  return {
    spec,
    dropReason: `npm registry confirms every claimed package version is published (${spec.name}@${spec.version}); finding's nonexistence claim is refuted by ground truth`,
  };
}
