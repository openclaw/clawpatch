---
title: Reporting
description: "Generate and filter finding reports in Markdown or JSON"
---

# Reporting

`clawpatch report` renders current findings.

```bash
clawpatch report
clawpatch report -o report.md
clawpatch report --json
clawpatch report --status open --severity high
clawpatch report --feature <featureId>
```

Markdown output includes:

- ranked action clusters when related maintainability/performance findings share
  a slop pattern and evidence area
- finding ID
- severity, category, confidence, triage, and status
- feature ID and title when available
- evidence file paths and line ranges when available
- reasoning text
- test-contract analysis when available
- suggested regression test and minimum fix scope when available
- recommendation and reproduction text when available
- next inspection command for status-filtered queues

Action clusters are report-only. They do not change finding IDs, status, triage,
or fix commands. They are intended to make deslopify-style reports easier to
scan by grouping repeated root causes such as duplication, dead code, wrapper
bloat, test coupling, defensive bloat, band-aid fixes, and concrete code bloat.
The full finding details remain in the report beneath the cluster summary.

`review` also writes a Markdown report for each run under:

```text
.clawpatch/reports/<runId>.md
```

Filters:

- `--status <status>`
- `--severity <severity>`
- `--feature <featureId>`
- `--category <category>`
- `--triage <triage>`

`--json` returns sorted machine-readable finding items with IDs, status,
severity, category, confidence, triage, feature info, evidence refs,
recommendation, reproduction, test-analysis, suggested-test, minimum-fix-scope,
and next-command fields. It does not require parsing Markdown.
