import { describe, expect, it } from "vitest";
import {
  evaluateFindingForDrop,
  extractPackageSpecs,
  findingClaimsNonexistence,
  verifyPackageSpec,
  type PackageSpec,
  type RegistryVerdict,
} from "./registry-verifier.js";

describe("findingClaimsNonexistence", () => {
  it("matches the canonical nonexistence phrasings", () => {
    expect(findingClaimsNonexistence("vitest@4.0.16 does not exist on npm")).toBe(true);
    expect(findingClaimsNonexistence("react@19.2.4 is not published on npm")).toBe(true);
    expect(findingClaimsNonexistence("@aws-sdk/client-s3@3.1000.0 is unpublished on npm")).toBe(
      true,
    );
    expect(findingClaimsNonexistence("mongodb@7.0.0 has ETARGET on public npm")).toBe(true);
    expect(findingClaimsNonexistence("Package mongodb@7.0.0 does not exist on npm")).toBe(true);
    expect(findingClaimsNonexistence("Pinned mongodb@7.0.0 is unpublished on npm")).toBe(true);
  });

  it("rejects findings that merely mention the words in unrelated contexts", () => {
    expect(findingClaimsNonexistence("Race condition allows duplicate message processing")).toBe(
      false,
    );
    expect(findingClaimsNonexistence("Authorization check missing on /internal route")).toBe(false);
    expect(
      findingClaimsNonexistence("Counter starts at zero and never increments existing rows"),
    ).toBe(false);
    expect(findingClaimsNonexistence("Vitest 4.0.16 is unreleased")).toBe(false);
    expect(findingClaimsNonexistence("invalid version pinned 11.1.3")).toBe(false);
    expect(findingClaimsNonexistence("react@19.2.4 doesn't exist in package-lock.json")).toBe(
      false,
    );
    expect(
      findingClaimsNonexistence("react@19.2.4 does not exist in the configured private registry"),
    ).toBe(false);
    expect(
      findingClaimsNonexistence(
        "@acme/widget@1.2.3 is unpublished from the configured GitHub Packages registry",
      ),
    ).toBe(false);
    expect(findingClaimsNonexistence("README says foo@1.2.3 is unpublished on npm")).toBe(false);
    expect(
      findingClaimsNonexistence(
        "foo@1.2.3 does not exist in package-lock.json but is available on npm",
      ),
    ).toBe(false);
    expect(findingClaimsNonexistence("foo@1.2.3 does not exist in npm cache")).toBe(false);
    expect(
      findingClaimsNonexistence(
        "foo@1.2.3 does not exist in npm and the lockfile integrity is corrupted",
      ),
    ).toBe(false);
    expect(
      findingClaimsNonexistence(
        "foo@1.2.3 is unpublished on npm. Its install script also leaks credentials",
      ),
    ).toBe(false);
    expect(
      findingClaimsNonexistence(
        "foo@1.2.3 runs a credential-stealing install script and is unpublished on npm",
      ),
    ).toBe(false);
  });

  it("rejects 'reads currentUserId from a non-existent field' (real bug, not a version claim)", () => {
    expect(
      findingClaimsNonexistence(
        "WatchedActivities reads currentUserId from a non-existent field on AppUser",
      ),
    ).toBe(false);
  });
});

describe("extractPackageSpecs", () => {
  it("extracts bare-name specs", () => {
    expect(extractPackageSpecs("mongodb@7.0.0 is not on npm")).toEqual([
      { name: "mongodb", version: "7.0.0" },
    ]);
  });

  it("extracts scoped-name specs", () => {
    expect(extractPackageSpecs("uses @types/node@24.10.4 which doesn't exist")).toEqual([
      { name: "@types/node", version: "24.10.4" },
    ]);
  });

  it("extracts deeply-scoped AWS SDK packages", () => {
    expect(extractPackageSpecs("pinned @aws-sdk/client-kms@3.1000.0")).toEqual([
      { name: "@aws-sdk/client-kms", version: "3.1000.0" },
    ]);
  });

  it("extracts prerelease versions", () => {
    expect(extractPackageSpecs("react@19.0.0-rc.1 is unreleased")).toEqual([
      { name: "react", version: "19.0.0-rc.1" },
    ]);
  });

  it("extracts versions with build metadata", () => {
    expect(extractPackageSpecs("pkg@1.2.3+sha.abcd0123 is invalid")).toEqual([
      { name: "pkg", version: "1.2.3+sha.abcd0123" },
    ]);
  });

  it("dedupes repeated specs in document order", () => {
    expect(
      extractPackageSpecs("mongodb@7.0.0 is invalid. Also mongodb@7.0.0. And vitest@4.0.16."),
    ).toEqual([
      { name: "mongodb", version: "7.0.0" },
      { name: "vitest", version: "4.0.16" },
    ]);
  });

  it("ignores trailing punctuation", () => {
    expect(extractPackageSpecs("mongodb@7.0.0, vitest@4.0.16.")).toEqual([
      { name: "mongodb", version: "7.0.0" },
      { name: "vitest", version: "4.0.16" },
    ]);
  });

  it("ignores partial / loose phrasings (mongodb 7.0)", () => {
    expect(extractPackageSpecs("mongodb 7.0 might not exist")).toEqual([]);
    expect(extractPackageSpecs("uses mongodb at version 7")).toEqual([]);
  });

  it("ignores email-shaped tokens", () => {
    expect(extractPackageSpecs("contact ops@example.com if pinned wrong")).toEqual([]);
  });

  it("returns no specs when text contains none", () => {
    expect(extractPackageSpecs("some unrelated finding text")).toEqual([]);
    expect(extractPackageSpecs("")).toEqual([]);
  });
});

type FetchInput = Parameters<typeof fetch>[0];

describe("verifyPackageSpec", () => {
  function makeFetch(implementations: Array<(input: FetchInput) => Promise<Response>>) {
    let call = 0;
    return ((input: FetchInput) => {
      const handler = implementations[call];
      call += 1;
      if (!handler) {
        throw new Error(`unexpected fetch call #${call}`);
      }
      return handler(input);
    }) as typeof fetch;
  }

  it("returns verified-published when registry returns 200 with matching name+version", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response(JSON.stringify({ version: "7.0.0", name: "mongodb" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict).toEqual({
      kind: "verified-published",
      name: "mongodb",
      version: "7.0.0",
    });
  });

  it("returns unknown when 200 body's name does not match the requested spec (mirror trickery defense)", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response(JSON.stringify({ name: "different-pkg", version: "7.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("returns unknown when 200 response has non-JSON content-type (HTML proxy login etc.)", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response("<html>SSO sign-in</html>", {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("returns unknown when content-length advertises a body larger than the cap", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response("{}", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Content-Length": String(10 * 1024 * 1024), // 10 MiB advertised
          },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("sends a User-Agent that identifies clawpatch", async () => {
    let seenUa: string | null = null;
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenUa = headers.get("User-Agent");
      void input;
      return Promise.resolve(
        new Response(JSON.stringify({ name: "mongodb", version: "7.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(seenUa).toMatch(/clawpatch/iu);
  });

  it("does not follow redirects (treats 302 as unknown)", async () => {
    const fetchImpl = ((_input: FetchInput, init?: RequestInit) => {
      // Node's global fetch with redirect:"error" rejects synchronously
      // when it sees a redirect; simulate that path explicitly.
      void init;
      return Promise.reject(new TypeError("unexpected redirect"));
    }) as typeof fetch;
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("returns unknown when 200 body has version but no name (defensive against partial mirror responses)", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response(JSON.stringify({ version: "7.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("propagates a caller-supplied abort signal (Ctrl-C / parent cancellation)", async () => {
    const fetchImpl = ((_input: FetchInput, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const callerController = new AbortController();
    const verdictPromise = verifyPackageSpec(
      { name: "mongodb", version: "7.0.0" },
      { fetchImpl, signal: callerController.signal },
    );
    callerController.abort();
    const verdict = await verdictPromise;
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") {
      expect(verdict.reason).toMatch(/caller signal/iu);
    }
  });

  it("annotates timeout with explicit timeoutMs in the unknown reason", async () => {
    const fetchImpl = ((_input: FetchInput, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const verdict = await verifyPackageSpec(
      { name: "mongodb", version: "7.0.0" },
      { fetchImpl, timeoutMs: 5 },
    );
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") {
      expect(verdict.reason).toMatch(/timed out after 5ms/iu);
    }
  });

  it("returns a typed verdict (not a rejected promise) when fetchImpl throws a non-Error value", async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      if (calls === 1) {
        // Symbol/null/undefined are valid throw targets but bypass
        // `instanceof Error` checks. The verifier's inner try/catch
        // converts them to a typed `unknown` verdict; the outer
        // `.catch()` wrapper at verifyPackageSpec is the belt-and-
        // suspenders backstop if a future refactor lets one through.
        throw null as unknown as Error;
      }
      return Promise.resolve(
        new Response(JSON.stringify({ name: "mongodb", version: "7.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof fetch;
    const cache = new Map<string, Promise<RegistryVerdict>>();
    const first = await verifyPackageSpec(
      { name: "mongodb", version: "7.0.0" },
      { fetchImpl, cache },
    );
    expect(first.kind).toBe("unknown");
    // Subsequent callers receive the cached typed verdict, not a
    // rejected promise — confirms the catch-wrapper invariant holds
    // even if the fetcher's exit shape is degenerate.
    const second = await verifyPackageSpec(
      { name: "mongodb", version: "7.0.0" },
      { fetchImpl, cache },
    );
    expect(second.kind).toBe("unknown");
  });

  it("returns verified-missing on 404", async () => {
    const fetchImpl = makeFetch([async () => new Response("Not Found", { status: 404 })]);
    const verdict = await verifyPackageSpec(
      { name: "doesnt-exist", version: "1.0.0" },
      { fetchImpl },
    );
    expect(verdict.kind).toBe("verified-missing");
  });

  it("returns unknown on transport failure (offline / DNS)", async () => {
    const fetchImpl = (() => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as typeof fetch;
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") {
      expect(verdict.reason).toContain("ENOTFOUND");
    }
  });

  it("returns unknown on 5xx responses", async () => {
    const fetchImpl = makeFetch([async () => new Response("Bad Gateway", { status: 502 })]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
    if (verdict.kind === "unknown") {
      expect(verdict.reason).toContain("502");
    }
  });

  it("returns unknown when 200 body is malformed (registry contract drift)", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response(JSON.stringify({ unrelated: "shape" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("returns unknown when 200 body's version differs from the requested one (defensive)", async () => {
    const fetchImpl = makeFetch([
      async () =>
        new Response(JSON.stringify({ version: "7.0.1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ]);
    const verdict = await verifyPackageSpec({ name: "mongodb", version: "7.0.0" }, { fetchImpl });
    expect(verdict.kind).toBe("unknown");
  });

  it("URL-encodes scoped package names correctly", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch([
      async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ name: "@types/node", version: "24.10.4" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ]);
    await verifyPackageSpec({ name: "@types/node", version: "24.10.4" }, { fetchImpl });
    expect(seen[0]).toBe("https://registry.npmjs.org/%40types%2Fnode/24.10.4");
  });

  it("uses cache to avoid duplicate registry calls", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ name: "mongodb", version: "7.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const cache = new Map<string, Promise<RegistryVerdict>>();
    const spec: PackageSpec = { name: "mongodb", version: "7.0.0" };
    await verifyPackageSpec(spec, { fetchImpl, cache });
    await verifyPackageSpec(spec, { fetchImpl, cache });
    await verifyPackageSpec(spec, { fetchImpl, cache });
    expect(calls).toBe(1);
  });

  it("dedupes concurrent in-flight requests for the same spec (no thundering herd)", async () => {
    let calls = 0;
    const resolvers: Array<(response: Response) => void> = [];
    const fetchImpl = (() => {
      calls += 1;
      return new Promise<Response>((resolve) => {
        resolvers.push(resolve);
      });
    }) as typeof fetch;
    const cache = new Map<string, Promise<RegistryVerdict>>();
    const spec: PackageSpec = { name: "mongodb", version: "7.0.0" };
    const promises = [
      verifyPackageSpec(spec, { fetchImpl, cache }),
      verifyPackageSpec(spec, { fetchImpl, cache }),
      verifyPackageSpec(spec, { fetchImpl, cache }),
    ];
    // Yield to the microtask queue so any synchronous-in-our-impl reads
    // of the cache settle before we assert on the call count.
    await Promise.resolve();
    // Resolve the single in-flight request; all three callers receive
    // the same verdict.
    resolvers[0]?.(
      new Response(JSON.stringify({ name: "mongodb", version: "7.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const verdicts = await Promise.all(promises);
    // The dedup invariant: by the time everything settles, only one
    // network call was issued regardless of microtask interleaving.
    expect(calls).toBe(1);
    expect(verdicts.every((verdict) => verdict.kind === "verified-published")).toBe(true);
  });

  it("respects custom registry base URL", async () => {
    const seen: string[] = [];
    const fetchImpl = makeFetch([
      async (input) => {
        seen.push(String(input));
        return new Response(JSON.stringify({ name: "mongodb", version: "1.0.0" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    ]);
    await verifyPackageSpec(
      { name: "mongodb", version: "1.0.0" },
      { fetchImpl, registryBase: "https://corp-registry.example/api" },
    );
    expect(seen[0]).toBe("https://corp-registry.example/api/mongodb/1.0.0");
  });

  it("aborts on timeout", async () => {
    const fetchImpl = ((_url: FetchInput, init?: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as typeof fetch;
    const verdict = await verifyPackageSpec(
      { name: "mongodb", version: "7.0.0" },
      { fetchImpl, timeoutMs: 5 },
    );
    expect(verdict.kind).toBe("unknown");
  });
});

function publishedFetchTracking(seen: string[]): typeof fetch {
  return (async (input: FetchInput) => {
    const url = String(input);
    seen.push(url);
    const segments = url.split("/");
    const version = segments.pop() ?? "";
    const name = decodeURIComponent(segments.pop() ?? "");
    return new Response(JSON.stringify({ name, version }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function publishedFetch(): typeof fetch {
  return (async (input: FetchInput) => {
    const url = String(input);
    // The URL is `${base}/${encodedName}/${version}` — pop version, then
    // pop and decode the (possibly scoped) name segment.
    const segments = url.split("/");
    const version = segments.pop() ?? "";
    const namePart = segments.pop() ?? "";
    // Scoped names are `%40scope/pkg` so the previous segment may be a
    // bare scope; restore it.
    let name = decodeURIComponent(namePart);
    if (name.startsWith("@")) {
      // No scoped names hit this helper currently, but be defensive.
      name = `${name}/${decodeURIComponent(segments.pop() ?? "")}`;
    }
    return new Response(JSON.stringify({ name, version }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

describe("evaluateFindingForDrop", () => {
  it("drops the finding when an extracted spec is verified-published", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "mongodb@7.0.0 does not exist on npm",
        reasoning: "mongodb@7.0.0 does not exist on npm.",
        recommendation: "Pin mongodb@6.21.0 instead.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).not.toBeNull();
    expect(result?.spec).toEqual({ name: "mongodb", version: "7.0.0" });
    expect(result?.dropReason).toContain("mongodb@7.0.0");
  });

  it("keeps the finding when its title doesn't make a nonexistence claim", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "Race condition in checkForNextMessage allows duplicate processing",
        reasoning: "May affect mongodb@7.0.0 connection pool, see provider.ts:117.",
        recommendation: "Add a mutex around the read-modify-write.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("does not drop a compound finding based on a reasoning-only registry claim", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "Dependency installation is broken",
        reasoning:
          "mongodb@7.0.0 does not exist on npm. The lockfile also contains an invalid integrity hash.",
        recommendation: "Fix both defects.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("keeps a public-npm title when reasoning identifies a configured private registry", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "@acme/widget@1.2.3 does not exist on npm",
        reasoning: "@acme/widget@1.2.3 does not exist in the configured GitHub Packages registry.",
        recommendation: "Publish it to the configured registry.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("keeps the finding when no extractable spec is present in title or body", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "Test script runs vitest with no test files present",
        reasoning: "package.json declares a test script but no tests/ directory exists.",
        recommendation: "Add tests or remove the script.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("keeps the finding when registry returns 404 (claim stands)", async () => {
    const fetchImpl = (async () => new Response("Not Found", { status: 404 })) as typeof fetch;
    const result = await evaluateFindingForDrop(
      {
        title: "fictional-pkg@99.99.99 is unpublished on npm",
        reasoning: "fictional-pkg@99.99.99 was never published on npm.",
        recommendation: "Remove the pin.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("keeps the finding when registry call fails (offline / network error)", async () => {
    const fetchImpl = (() => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    const result = await evaluateFindingForDrop(
      {
        title: "mongodb@7.0.0 is unpublished on npm",
        reasoning: "mongodb@7.0.0 does not exist on npm.",
        recommendation: "Pin mongodb@6.21.0 instead.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("keeps multi-version publication claims", async () => {
    const seen: string[] = [];
    const fetchImpl = publishedFetchTracking(seen);
    const result = await evaluateFindingForDrop(
      {
        title: "mongodb@7.0.0 and vitest@4.0.16 are unpublished on npm",
        reasoning: "Both packages are pinned to versions that don't exist on npm.",
        recommendation: "Use mongodb@6.21.0 and vitest@3.2.4.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it("keeps a multi-version finding when any claimed version is missing", async () => {
    const fetchImpl = (async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/fictional-pkg/")) {
        return new Response("Not Found", { status: 404 });
      }
      const segments = url.split("/");
      const version = segments.pop() ?? "";
      const name = decodeURIComponent(segments.pop() ?? "");
      return new Response(JSON.stringify({ name, version }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await evaluateFindingForDrop(
      {
        title: "fictional-pkg@1.0.0 and mongodb@7.0.0 are unpublished on npm",
        reasoning: "Both do not exist on npm.",
        recommendation: "Fix.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("does not treat a published recommendation as refuting a missing version", async () => {
    const fetchImpl = (async (input: FetchInput) => {
      if (String(input).includes("/99.99.99")) {
        return new Response("Not Found", { status: 404 });
      }
      return new Response(JSON.stringify({ name: "fictional-pkg", version: "1.0.0" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await evaluateFindingForDrop(
      {
        title: "fictional-pkg@99.99.99 is unpublished on npm",
        reasoning: "fictional-pkg@99.99.99 does not exist on npm.",
        recommendation: "Use fictional-pkg@1.0.0 instead.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("keeps a finding when reasoning adds another missing claimed version", async () => {
    const fetchImpl = (async (input: FetchInput) => {
      const url = String(input);
      if (url.includes("/bar/9.0.0")) {
        return new Response("Not Found", { status: 404 });
      }
      const segments = url.split("/");
      const version = segments.pop() ?? "";
      const name = decodeURIComponent(segments.pop() ?? "");
      return new Response(JSON.stringify({ name, version }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    const result = await evaluateFindingForDrop(
      {
        title: "foo@2.0.0 and bar@9.0.0 are unpublished on npm",
        reasoning: "foo@2.0.0 and bar@9.0.0 are unpublished on npm.",
        recommendation: "Fix the pins.",
      },
      { fetchImpl },
    );
    expect(result).toBeNull();
  });

  it("does not treat generic invalid-version compatibility findings as nonexistence claims", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "Invalid version pinned: react@19.0.0 conflicts with the supported peer range",
        reasoning: "The version is published but incompatible with the declared peer dependency.",
        recommendation: "Use a compatible published version.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("does not combine a private-registry claim with unrelated public npm context", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "foo@1.2.3 is unpublished from the configured GitHub Packages registry",
        reasoning: "Unlike public npm, this project installs from GitHub Packages.",
        recommendation: "Publish the package to the configured registry.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });

  it("does not drop documentation findings that quote an unpublished-package claim", async () => {
    const result = await evaluateFindingForDrop(
      {
        title: "README incorrectly says foo@1.2.3 is unpublished on npm",
        reasoning: "The package exists and the documentation is stale.",
        recommendation: "Correct the README.",
      },
      { fetchImpl: publishedFetch() },
    );
    expect(result).toBeNull();
  });
});
