import { ClawpatchError } from "../errors.js";
import type { PartitionedReviewOutput, Provider } from "../provider-types.js";
import type { AgentMapOutput, FixPlanOutput, RevalidateOutput, ReviewFinding } from "../types.js";

function bugFinding(evidencePath: string): ReviewFinding {
  return {
    title: "Marker bug found",
    category: "bug",
    severity: "medium",
    confidence: "high",
    evidence: [
      {
        path: evidencePath,
        startLine: null,
        endLine: null,
        symbol: null,
        quote: "TODO_BUG",
      },
    ],
    reasoning: "Mock provider found an explicit bug marker.",
    reproduction: null,
    recommendation: "Replace marker with real handling.",
    whyTestsDoNotAlreadyCoverThis: "Mock fixtures do not encode this marker as intended behavior.",
    suggestedRegressionTest: "Add a focused test that fails when TODO_BUG is present.",
    minimumFixScope: "Replace the marker in the owning feature file.",
  };
}

function simplificationFinding(evidencePath: string): ReviewFinding {
  return {
    title: "Late simplification finding",
    category: "maintainability",
    severity: "low",
    confidence: "high",
    evidence: [
      {
        path: evidencePath,
        startLine: null,
        endLine: null,
        symbol: null,
        quote: "DESLOPIFY_LATE",
      },
    ],
    reasoning: "Mock provider returned a simplification finding after a general finding.",
    reproduction: null,
    recommendation: "Keep the deslopify finding after mode filtering.",
    whyTestsDoNotAlreadyCoverThis:
      "Mock fixtures need to prove filtering occurs before the finding cap.",
    suggestedRegressionTest: null,
    minimumFixScope: "Filter before capping.",
  };
}

export const mockProvider: Provider = {
  name: "mock",
  async check(): Promise<string> {
    return "mock";
  },
  async map(_root: string, prompt: string): Promise<AgentMapOutput> {
    const paths = [...prompt.matchAll(/"([^"]*agent\/[^"]+\.[^"]+)"/gu)]
      .map((match) => match[1]?.trim())
      .filter((path): path is string => path !== undefined && path.length > 0);
    const owned = [...new Set(paths.filter((path) => !/test|spec/u.test(path)))].slice(0, 6);
    const tests = paths.filter((path) => /test|spec/u.test(path)).slice(0, 3);
    return {
      features:
        owned.length === 0
          ? []
          : [
              {
                title: "Agent mapped package agent",
                summary: "Mock agent mapper grouped otherwise unmapped agent files.",
                kind: "library",
                confidence: "medium",
                entrypoints: [{ path: owned[0]!, symbol: null, route: null, command: null }],
                ownedFiles: owned.map((path) => ({ path, reason: "agent mapper owned file" })),
                contextFiles: tests.map((path) => ({ path, reason: "agent mapper nearby test" })),
                tests: tests.map((path) => ({
                  path,
                  command: "touch SHOULD_NOT_RUN_AGENT_MAP",
                })),
                tags: ["agent-mapped"],
                trustBoundaries: [],
                reason: "Mock provider detected the agent/ source group.",
              },
            ],
      notes: ["mock agent map"],
    };
  },
  async review(_root: string, prompt: string): Promise<PartitionedReviewOutput> {
    if (!prompt.includes("TODO_BUG") && !prompt.includes("BUG:")) {
      return {
        findings: [],
        inspected: { files: [], symbols: [], notes: ["mock clean"] },
        droppedFindings: [],
      };
    }
    const evidencePath = prompt.includes("BAD_EVIDENCE")
      ? "src/not-included.ts"
      : (firstPromptFileWith(prompt, "TODO_BUG") ?? "src/index.ts");
    const findings = prompt.includes("DESLOPIFY_LATE")
      ? [
          { ...bugFinding(evidencePath), title: "General bug first" },
          simplificationFinding(evidencePath),
        ]
      : [bugFinding(evidencePath)];
    return {
      findings,
      inspected: {
        files: [evidencePath],
        symbols: [],
        notes: [prompt.includes("DESLOPIFY_LATE") ? "mock mixed findings" : "mock finding"],
      },
      droppedFindings: [],
    };
  },
  async fix(): Promise<FixPlanOutput> {
    return {
      summary: "mock fix plan",
      findingIds: [],
      plannedFiles: [],
      risk: "low",
      steps: ["mock"],
      validationCommands: ["touch SHOULD_NOT_RUN_PROVIDER_COMMANDS"],
    };
  },
  async revalidate(_root: string, prompt: string): Promise<RevalidateOutput> {
    if (prompt.includes("REVALIDATE_PATCH_EVIDENCE")) {
      const complete =
        prompt.includes('"status": "validated"') &&
        prompt.includes('"matchedExpectedValidation": true') &&
        prompt.includes('"exitCode": 0') &&
        !prompt.includes("SECRET_OUTPUT_MUST_NOT_REACH_REVALIDATION") &&
        !prompt.includes("PRIVATE_ERROR_MUST_NOT_REACH_REVALIDATION");
      return complete
        ? { outcome: "fixed", reasoning: "mock patch evidence supports fix", commands: [] }
        : { outcome: "uncertain", reasoning: "mock patch evidence incomplete", commands: [] };
    }
    for (const [marker, outcome, reasoning] of [
      ["REVALIDATE_FIXED", "fixed", "mock fixed outcome"],
      ["REVALIDATE_OPEN", "open", "mock open outcome"],
      ["REVALIDATE_FALSE_POSITIVE", "false-positive", "mock false-positive outcome"],
    ] as const) {
      if (prompt.includes(marker)) {
        return { outcome, reasoning, commands: [`mock ${outcome}`] };
      }
    }
    return { outcome: "uncertain", reasoning: "mock provider cannot inspect fixes", commands: [] };
  },
};

function firstPromptFileWith(prompt: string, marker: string): string | null {
  for (const block of prompt.split(/^--- /gmu).slice(1)) {
    const newline = block.indexOf("\n");
    if (newline === -1) continue;
    const path = block
      .slice(0, newline)
      .replace(/ \([^)]*\)$/u, "")
      .trim();
    if (path.length > 0 && block.slice(newline + 1).includes(marker)) return path;
  }
  return null;
}

export const mockFailProvider: Provider = {
  name: "mock-fail",
  async check(): Promise<string> {
    return "mock-fail";
  },
  async map(): Promise<AgentMapOutput> {
    throw mockFailure("map");
  },
  async review(): Promise<PartitionedReviewOutput> {
    throw mockFailure("review");
  },
  async fix(): Promise<FixPlanOutput> {
    throw mockFailure("fix");
  },
  async revalidate(): Promise<RevalidateOutput> {
    throw mockFailure("revalidate");
  },
};

function mockFailure(operation: string): ClawpatchError {
  return new ClawpatchError(`mock ${operation} failure`, 1, "mock-failure");
}
