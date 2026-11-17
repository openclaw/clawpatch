<!--
Optional linked context:
Add a visible `Closes #<issue-number>` or `Related: #<issue-number>` line
below this comment.

Required PR title:
type: user-facing description
Use a parenthesized scope only when it adds clarity:
fix(provider): review fails when the repository path contains spaces

Types: feat, fix, improve, refactor, docs, chore.
For fixes, describe the user-visible symptom and trigger:
fix: review cannot resume after an interrupted run
Avoid implementation details such as:
fix: add null check to run record

**MUST:** Keep **Allow edits from maintainers** enabled for this PR so maintainers
can help update the branch when needed.
-->

## What Problem This Solves

<!--
Describe the concrete user, product, or operational problem.
Use one short, plain-language sentence. For fixes, prefer:
"Fixes: <what goes wrong> when <trigger or condition>."
For other changes, describe the need without inventing a bug.
Name the affected workflow, not the code-level cause. A reader should understand
the problem without knowing clawpatch internals. The title examples above are
illustrative, not claims about current bugs.
-->

## User Impact

<!--
"User impact: <what users, operators, or developers can now do or expect>."
Lead with the concrete outcome in plain language, usually one sentence.
For internal-only changes, say there is no user-visible change; do not invent a benefit.
Keep important risks, breaking changes, migrations, and required user actions visible here.
For example, describe whether maintainers can map a project, resume a review,
validate a finding, or open a patch PR; use only the outcome this change delivers.
-->

## Why This Change Was Made

<!--
Briefly explain how the change addresses the problem without repeating the impact.
Keep the body short. Leave file lists, internal acronyms, and root-cause walkthroughs
in the diff or optional <details>; include technical detail only when it explains
behavior or a material tradeoff. Do not hide risks or required actions in <details>.
-->

## Evidence

<!--
Show the most useful proof that this change works. Screenshots, screencasts,
terminal output, focused tests, CI results, live observations, redacted logs,
and artifact links are all useful. Include before/after evidence for visual
changes when it clarifies the result.

Reviewers will inspect the code, tests, and CI. Use this section to make the
validation easy to understand, not to restate the diff.
Summarize what was checked and the result; note meaningful gaps. Start with the
observed outcome, not just a command list or a claim that tests passed. For a
mapping change, say which project shape was checked and whether the expected
feature slices appeared. For a review or patching change, describe the exercised
workflow and its result. Include the exact checks run, and distinguish passed,
failed, and untested behavior; do not imply broader coverage than the evidence.
Link long output or put it in optional <details>, keeping the useful evidence
summary visible.
-->
