import { describe, expect, it } from "vitest";
import { findingClusters, renderReport } from "./reporting.js";
import type { FindingRecord } from "./types.js";

describe("reporting", () => {
  it("clusters and ranks related slop findings without hiding detail", () => {
    const duplicateMedium = finding({
      id: "fnd_duplicate_medium",
      title: "Alert CLIs duplicate the same position loader",
      severity: "medium",
      confidence: "high",
      path: "scripts/cli/news_signal_search.py",
      reasoning: "Two CLI paths duplicate the same loader and can drift.",
      recommendation: "Consolidate the duplicate loader.",
    });
    const duplicateLow = finding({
      id: "fnd_duplicate_low",
      title: "Alert renderer repeats position scope filtering",
      path: "scripts/cli/portfolio_event_alert.py",
      reasoning: "Repeated filtering creates a parallel alert scope.",
      recommendation: "Reuse the shared loader.",
    });
    const deadLow = finding({
      id: "fnd_dead_low",
      title: "Dead strategy helper should be deleted",
      path: "core/services/strategy.py",
      reasoning: "Unused helper is dead code.",
      recommendation: "Delete the unused helper.",
    });

    const report = renderReport([deadLow, duplicateLow, duplicateMedium]);

    expect(findingClusters([deadLow, duplicateLow, duplicateMedium])).toHaveLength(1);
    expect(report).toContain("clusters: 1");
    expect(report).toContain("cluster 1: scripts/cli duplication (2 findings)");
    expect(report).toContain("- medium/high fnd_duplicate_medium: Alert CLIs duplicate");
    expect(report).toContain("- low/high fnd_duplicate_low: Alert renderer repeats");
    expect(report).toContain("## low: Dead strategy helper should be deleted");
    expect(report.indexOf("## medium: Alert CLIs duplicate")).toBeLessThan(
      report.indexOf("## low: Alert renderer repeats"),
    );
  });

  it("does not cluster unrelated single findings", () => {
    const report = renderReport([
      finding({
        id: "fnd_single",
        title: "Delete unused wrapper",
        path: "core/services/wrapper.py",
        reasoning: "One unused wrapper exists.",
        recommendation: "Delete it.",
      }),
    ]);

    expect(report).toContain("findings: 1");
    expect(report).not.toContain("clusters:");
    expect(report).not.toContain("## action clusters");
  });

  it("prefers concrete wrapper and bloat labels over generic legacy wording", () => {
    const report = renderReport([
      finding({
        id: "fnd_wrapper_one",
        title: "Legacy pass-through wrapper hides event rendering",
        path: "scripts/cli/events.py",
        reasoning: "The deprecated no-op wrapper only forwards to the real renderer.",
        recommendation: "Delete the pass-through layer.",
      }),
      finding({
        id: "fnd_wrapper_two",
        title: "Legacy alias wrapper keeps an obsolete path alive",
        path: "scripts/cli/alerts.py",
        reasoning: "The alias shim forwards every call without owning behavior.",
        recommendation: "Call the renderer directly.",
      }),
    ]);

    expect(report).toContain("cluster 1: scripts/cli wrapper bloat (2 findings)");
    expect(report).not.toContain("cluster 1: scripts/cli dead code");
  });

  it("ranks severe clusters before larger low-severity clusters", () => {
    const report = renderReport([
      finding({
        id: "fnd_low_one",
        title: "CLI one duplicates a helper",
        path: "scripts/cli/one.py",
        reasoning: "This duplicate helper is low risk.",
        recommendation: "Share the helper.",
      }),
      finding({
        id: "fnd_low_two",
        title: "CLI two duplicates a helper",
        path: "scripts/cli/two.py",
        reasoning: "This duplicate helper is low risk.",
        recommendation: "Share the helper.",
      }),
      finding({
        id: "fnd_low_three",
        title: "CLI three duplicates a helper",
        path: "scripts/cli/three.py",
        reasoning: "This duplicate helper is low risk.",
        recommendation: "Share the helper.",
      }),
      finding({
        id: "fnd_high_one",
        title: "Core worker hides errors behind wrappers",
        severity: "high",
        path: "core/services/worker.py",
        reasoning: "The wrapper hides production errors.",
        recommendation: "Remove the wrapper.",
      }),
      finding({
        id: "fnd_high_two",
        title: "Core runner hides errors behind wrappers",
        severity: "high",
        path: "core/services/runner.py",
        reasoning: "The wrapper hides production errors.",
        recommendation: "Remove the wrapper.",
      }),
    ]);

    expect(report.indexOf("cluster 1: core wrapper bloat")).toBeLessThan(
      report.indexOf("cluster 2: scripts/cli duplication"),
    );
  });

  it("keeps unclustered critical findings ahead of low-severity cluster details", () => {
    const report = renderReport([
      finding({
        id: "fnd_low_one",
        title: "CLI one duplicates a helper",
        path: "scripts/cli/one.py",
        reasoning: "This duplicate helper is low risk.",
        recommendation: "Share the helper.",
      }),
      finding({
        id: "fnd_low_two",
        title: "CLI two duplicates a helper",
        path: "scripts/cli/two.py",
        reasoning: "This duplicate helper is low risk.",
        recommendation: "Share the helper.",
      }),
      finding({
        id: "fnd_critical",
        title: "Data export deletes unrelated files",
        category: "data-loss",
        severity: "critical",
        path: "core/export.ts",
        reasoning: "Cleanup can delete files outside the export directory.",
        recommendation: "Constrain deletion to the export directory.",
      }),
    ]);

    expect(report.indexOf("## critical: Data export deletes")).toBeLessThan(
      report.indexOf("## low: CLI one duplicates"),
    );
  });

  it("does not treat ordinary words containing any as type-silencing slop", () => {
    const report = renderReport([
      finding({
        id: "fnd_company_one",
        title: "Company loader keeps legacy branches",
        path: "core/company.py",
        reasoning: "Company metadata keeps obsolete branches.",
        recommendation: "Delete the dead branch.",
      }),
      finding({
        id: "fnd_company_two",
        title: "Company parser keeps unused branches",
        path: "core/company_parser.py",
        reasoning: "Company parser keeps unused branches.",
        recommendation: "Delete the dead branch.",
      }),
    ]);

    expect(report).toContain("cluster 1: core dead code (2 findings)");
    expect(report).not.toContain("band-aid");
  });
});

function finding(overrides: {
  id: string;
  title: string;
  path: string;
  reasoning: string;
  recommendation: string;
  severity?: FindingRecord["severity"];
  confidence?: FindingRecord["confidence"];
  category?: FindingRecord["category"];
}): FindingRecord {
  const now = "2026-05-17T00:00:00.000Z";
  return {
    schemaVersion: 1,
    findingId: overrides.id,
    featureId: "feat_test",
    title: overrides.title,
    category: overrides.category ?? "maintainability",
    severity: overrides.severity ?? "low",
    confidence: overrides.confidence ?? "high",
    triage: "risk",
    evidence: [
      {
        path: overrides.path,
        startLine: 1,
        endLine: 2,
        symbol: null,
        quote: null,
      },
    ],
    reasoning: overrides.reasoning,
    reproduction: null,
    recommendation: overrides.recommendation,
    whyTestsDoNotAlreadyCoverThis: "",
    suggestedRegressionTest: null,
    minimumFixScope: "",
    status: "open",
    history: [],
    signature: overrides.id,
    linkedPatchAttemptIds: [],
    createdByRunId: "run_test",
    createdAt: now,
    updatedAt: now,
  };
}
