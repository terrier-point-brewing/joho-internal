---
name: feedback-final-review-catches-real-bugs
description: "Never skip the mandatory final whole-branch review, even under token/spawn budget pressure — it catches bugs per-task review misses"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: bf2a7637-ba37-4fac-aad2-bedf002cd197
  modified: 2026-07-25T02:05:57.880Z
---

Always run the final whole-branch Opus review to completion, even when spawn/token budget
pressure tempts consolidating or skipping it for "lower-risk" remaining work.

**Why:** In [[project_payroll_gl_account_split]], three locality groups had already passed
dedicated task-scoped review (including two real bugs caught and fixed at that stage) before the
final whole-branch review ran. That final review still found a fresh Critical bug — split GL
lines stored with the wrong cash-direction sign, which would have silently inverted every split
payroll transaction's P&L impact. None of the per-task reviews caught it because each one only
saw its own task's diff in isolation; the bug only became visible when reasoning about the full
write path (parser → matcher → DB → Financials aggregation → sign normalization) end-to-end,
which is exactly what a whole-branch review is for and a task-scoped review structurally cannot
do.

**Confirmed again 2026-07-24** in [[project-transaction-manual-guards]], with the same shape:
four groups had passed task-scoped review (which itself caught a latent prod outage) before the
final whole-branch Opus review found a fresh Critical — writing manual GL splits onto an expense
that already had `payroll_auto` splits double-counts it in the P&L, because `aggregateRows`
replaces the parent with the union of ALL split rows regardless of `split_source`. No per-group
review could see it: the manual-split *writer* and the payroll-split *reader* live in different
groups, and the new code balances correctly when judged on its own. Cross-group interaction
between new writers and pre-existing readers is the recurring blind spot.

**How to apply:** When under spawn-budget pressure (see `.claude/hooks/spawn-guard.js` and the
project's Execution Budget convention), consolidate *implementation* dispatches and skip
*per-group* review dispatches for lower-risk work if needed — but never skip or shortcut the
single final whole-branch review. It is the one review pass explicitly exempted from the
per-task "review economy" squeeze in this project's CLAUDE.md, and this incident is the concrete
evidence for why.
