---
name: feedback-frozen-tests-as-equivalence-gate
description: "When refactoring a computation path, freeze its existing test file as the equivalence gate instead of writing a new fixture comparison"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 089b10c8-4055-460d-b4a3-610a24f8b30a
  modified: 2026-07-28T16:33:28.509Z
---

When refactoring a live computation path (payroll, invoicing, volume ledger), designate the module's **existing** test file as FROZEN and make "it passes unmodified" the acceptance criterion — rather than writing a fresh fixture-comparison test.

**Why:** on the 2026-07-27 payroll day-override refactor, `lib/payroll/__tests__/previewService.test.ts` already mocked exactly the two Square fetchers and asserted real computed output across employee filtering, attribution, guarantee bucketing at every frequency, adjustment merge, labels, and totals. It was a stronger equivalence harness than anything worth hand-building, and it cost nothing. Repos with this shape of test already have the gate; writing a new one duplicates it and proves less.

**How to apply:**
- State it as a Global Constraint in the plan: "FROZEN — if a change makes it fail, the change is wrong; fix the change, never the test. Adding cases is allowed; modifying or deleting existing ones is not."
- Verify mechanically, not by trust: `git diff --stat <merge-base> HEAD -- <test file>` must be empty, and grep the range's deletions (`git diff … | grep '^-'`) — a subagent reporting "frozen file untouched" is not evidence.
- **Expect exactly one class of legitimate conflict:** a frozen test that pins the *bug you are fixing*. Here one case asserted `[33,33,33]` with the comment "rounding loses 1 cent total" — it encoded the per-cell `Math.round` drift that the new largest-remainder rule exists to remove. That is a plan contradiction, not a refactor error: surface the test text next to the spec text and let the human choose. Do not let a subagent resolve it.
- A subagent that hits this should escalate rather than edit. The implementer that did (returning NEEDS_CONTEXT with the analysis, uncommitted) was behaving correctly.

**Freeze the whole blast radius, not just the module's own test file.** On the 2026-07-28 tips pass-through, `lib/finance/financials/normalizeSign.ts` was frozen via its own `normalizeSign.test.ts` — but the change's actual regressions surfaced in `aggregateRows.test.ts` and `buildFinancials.test.ts`, which were outside the gate. They failed loudly and were resolved correctly, so nothing shipped broken, but the gate did not cover them by design. For a **shared pure function**, freeze every test file that transitively asserts on its output. A cheap way to find them: grep for the function name plus the test files of every module that imports it.

Related: [[feedback_final_review_catches_real_bugs]], [[project_payroll_day_override_grid]], [[project_tips_balance_sheet_passthrough]].
