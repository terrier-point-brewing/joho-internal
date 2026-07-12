# Agent Token-Efficiency Audit — 2026-07-11

## Diagnosis: where the 1M+ output tokens go

Measured from repo artifacts (`docs/superpowers/plans/`, `.superpowers/sdd/`):

**1. The same code is written 3–4 times (dominant cause, ~60–70% of output).**
Plans contain complete verbatim implementations — `2026-06-27-export-ui-redesign.md` is 100KB (~25k tokens), and 42 plans total 1.85MB. The pipeline then re-emits that code repeatedly:

1. Opus planner writes full code bodies into the plan (~25k tokens output)
2. Orchestrator copies plan sections into per-task briefs (`task-9-brief.md` is 25KB — the entire component source, emitted again)
3. Implementer subagent types the code into the actual file (third emission)
4. Reviewer/reports quote portions back (fourth, partial)

A 5k-line feature costs ~15–20k lines of emitted code. This alone explains the 1M+ figure.

**2. Opus High does transcription work.** Task briefs like Task 9 are "create this file with this exact code" — mechanical work a cheaper model does identically. Opus adds value at the spec/plan/final-review stages, not when copying its own plan into files.

**3. Review pipeline is double-Opus and diff-heavy.** Every task gets a per-task review (diffs up to 175KB read into context) *plus* a final whole-branch Opus review. `progress.md` shows even a docs-only append task got a full review cycle. Each line of code is reviewed at least twice.

**4. Repeat context gathering per subagent.** 6–7 tasks × (implementer + reviewer) ≈ 14 cold starts, each re-ingesting CLAUDE.md (9KB) + UI_STANDARD.md (18KB) + production-schema.md + AGENTS.md's directive to read `node_modules/next/dist/docs/` (3.6MB tree). Mostly input tokens, but agents also restate context in output.

**5. Oversized source files inflate every touch.** `BatchLogTab.tsx` (1,925 lines), `BrewStatusTab.tsx` (1,418), `ExportBayTab.tsx` (1,195). Any edit means large reads, large `old_string` matches, large diffs, large review payloads.

**6. Repo debris.** `.claude/worktrees/` holds 3.7GB across 11 stale worktrees; `.superpowers/sdd/` holds 1MB of finished-branch review diffs. Not direct token burn, but stale worktrees waste disk and risk polluting searches.

---

## Fixes

### A. Plan format: contracts, not code (biggest single win, do first)

Add to CLAUDE.md so it overrides the superpowers plan-writing default:

> Plans and task briefs specify **file map, interfaces/types, function signatures, acceptance criteria, and test cases — never full implementation bodies**. Inline code is allowed only for genuinely non-obvious logic and capped at ~20 lines per task. A task brief must be executable by a competent engineer who has the brief + the repo, without the plan.

Expected effect: plan output drops ~80% (100KB → ~15KB), brief duplication drops proportionally, and implementers write each line once. Target: full spec build ≈ 300–400k output tokens instead of 1M+.

*(Alternative if you prefer code-complete plans: keep them, but then implementers must be Haiku — paying Opus to transcribe Opus is the worst of both.)*

### B. Phase-based model routing (replace current Model Selection section)

| Phase | Model | Rationale |
|---|---|---|
| Spec / brainstorm / architecture | Opus | High blast radius, one-shot |
| Plan writing | Opus (Sonnet if ≤3 files) | Needs whole-system view |
| Implementation subagents | **Sonnet default** | Briefs make tasks well-scoped |
| Mechanical tasks (docs, config, test scaffolds, rename/move, brief says "exact code") | **Haiku** | Transcription |
| Per-task review | Sonnet | Diff-scoped, findings-only |
| Final whole-branch review | Opus | Once per feature |
| Migrations / irreversible data ops | Opus | Existing rule, keep |

Operationalize it: the plan's task table gets a `model` column, and the orchestrator passes it as the Agent tool's `model` param per spawn. Signals for bumping a task to Opus: touches `volumeLedger.ts`/`commitments.ts`/migrations, novel algorithmic logic, or a Sonnet attempt failed review twice.

### C. Subagent tiering (amend the "full spec builds require subagents" rule)

- ≤3 files or ~≤300 LOC delta → single inline session with a checklist; no plan doc, no subagents.
- 4–6 files → plan + inline execution (`executing-plans`), no per-task agent spawns.
- Only true multi-group parallel plans → subagent-driven development.
- **Group tasks by file locality, not just dependency.** Tasks touching the same route/component (e.g., invoices API + invoices tab) go to one agent sequentially — one context load instead of three. Parallelism saves wall-clock, not tokens; every extra spawn is a cold context rebuild.

### D. Kill repeat context gathering

- Create `docs/agent-context.md` (~2KB): distilled conventions cheat sheet (auth pattern, client selection, `requireDateRange`/`apiError`, token utilities, btn/inp/Card primitives, test threshold). Task briefs reference it; subagents read it **instead of** UI_STANDARD.md + CLAUDE.md deep-dives. Full docs only on explicit trigger.
- Distill Next.js 16 deltas once into `docs/nextjs16-deltas.md` (~2KB) and rewrite AGENTS.md to point there first; `node_modules/next/dist/docs/` only when the delta doc doesn't cover the question. Today every subagent is told to browse a 3.6MB doc tree.
- Briefs should state: "This brief is authoritative and self-contained. Do NOT read the plan or spec." (Current briefs are nearly self-contained — make it explicit.)
- Orchestrator pastes the 10–30 relevant lines of an existing file into the brief rather than letting the subagent re-explore.

### E. Review economy

- Per-task reviews: Sonnet, scoped to the diff, output = findings list only (severity + file:line + one-line fix), no diff quoting, no prose summary of what the code does.
- Skip review entirely for docs-only, config-only, and generated-file tasks.
- Keep the single final Opus whole-branch review as the quality backstop.

### F. Repo structure

- Split the >800-line tab components (`BatchLogTab`, `BrewStatusTab`, `ExportBayTab`, `IngredientsTab`, `BatchSchedulerTab`, chart-of-accounts/account-mapping pages) into subcomponents + hooks. This is already your stated architecture rule — enforcing it is also a token optimization: smaller reads, smaller diffs, cheaper reviews. Add a soft lint ceiling (~400 lines/component) so files can't regrow.
- Add `"typecheck": "tsc --noEmit"` and a single `"verify": lint + typecheck + vitest` script so each subagent's DoD loop is one command instead of iterative build/test churn.
- Cleanup: prune merged worktrees under `.claude/worktrees/` (3.7GB) and delete `.superpowers/sdd/` review diffs for merged branches. Archive `docs/superpowers/plans/` for shipped features into `plans/archive/` so directory listings during planning stay small.

### G. Security (found during audit, unrelated to tokens)

`.claude/settings.local.json` permission allow-rules embed a live Square bearer token in plaintext curl commands. **Rotate that token** and replace the rules with pattern-based entries that don't inline credentials.

---

## Expected impact

| Change | Output-token effect on a 6–7 task spec build |
|---|---|
| A. Contract-style plans | −40–50% (eliminates emissions #1–2 of the same code) |
| B. Model routing | −cost, not tokens: Sonnet/Haiku tokens are 5–20× cheaper |
| C. Fewer/grouped spawns | −10–15% (fewer cold context rebuilds) |
| D. Context cheat sheets | −input tokens per spawn; −5% output (less restating) |
| E. Review economy | −10–15% |

Combined: a build that costs 1M+ Opus-High output tokens today should land around 300–400k tokens, mostly on Sonnet.

---

## Enforcement update — 2026-07-12

The fixes above shipped into CLAUDE.md as prose. The very next feature (tax-submission-module) burned **~3M tokens on implementation** anyway, despite a fully compliant plan (model column, contract-style tasks, locality grouping). Post-mortem:

**The artifacts were not the problem.** Spec (325 lines) + plan (644 lines) ≈ 15KB. You cannot spend 3M tokens producing 15KB.

**The cost model is `cost ≈ spawn_count × per-spawn context tax`** — and it's now measured, not estimated. Reading the run's own subagent transcripts (`<session>/subagents/agent-*.jsonl`):

| | subagents | orchestrator | total |
|---|---|---|---|
| count | **50** | 1 | — |
| output tokens | 696k | 452k | **1.15M** |
| cache-write (context ingested) | **10.9M** | 2.4M | **13.2M** |

Two facts fall out: **(1) context ingestion is ~92% of token volume** (13.2M cache-write vs 1.15M output) — the bill is reading, not writing; **(2) the plan grouped 20 tasks into ~6 locality groups but spawned 50 subagents** (~2.5 per task: implementer + reviewer + extras), because its header said `REQUIRED SUB-SKILL: subagent-driven-development`, biasing the executor toward per-task fan-out. Each subagent averaged ~222k cache-write. Collapsing 50 → ~8 grouped spawns cuts ~10.9M → ~1.8M of subagent context tax — the single biggest lever, confirmed by the numbers.

Of that per-spawn ~222k: a fixed floor (harness prompt + CLAUDE.md + skill/MCP-name lists) ≈ 40–60k; the rest is work-context the subagent reads (plan, spec, source, docs). Closed briefs attack the work-context; the fixed floor is trimmed by the connector/plugin config below.

**Prose alone doesn't bite.** Adding rules to CLAUDE.md was already tried (this doc) and drifted within one feature. Enforcement now has three teeth:

1. **`.claude/hooks/spawn-guard.js`** (`PreToolUse`, matcher `Agent|Task`) — counts spawns per session, injects a consolidation warning past the cap (default 12, `CLAUDE_SPAWN_CAP`). Non-blocking so it can't wedge a legit large run. This is the one deterministic, harness-executed lever against the sole cost driver.
2. **`.claude/hooks/token-log.js`** (`Stop` + `SubagentStop`) — logs per-subagent + session token spend to `.claude/token-usage.log` (gitignored). Subagent spend lives in separate transcripts, so a top-session-only view (incl. `rtk gain` on the orchestrator) misses exactly the fan-out cost that blows budgets. Per-spawn rows make it visible.
3. **Plan `Execution Budget` header** (required by CLAUDE.md → Plans & Task Briefs) — puts the spawn cap + mode + token target in the *plan the executor actively follows*, and explicitly overrides the writing-plans "subagent-driven (recommended)" stamp with the tier table. `Spawn cap = (# locality groups) + 2`.

Why not patch the plan generator to stop stamping "subagent-driven"? It's a shared, versioned, cached plugin skill (`~/.claude/plugins/.../writing-plans`) — editing it is fragile and leaks into every project. The repo-level override (rule + header) is the correct layer.

### Reducing the per-spawn tax itself

Spawn count is the dominant lever, but the ~40–60k fixed floor per spawn is partly config, not physics:

4. **Lean `impl` subagent type** (`.claude/agents/impl.md`) — restricted toolset (`Read/Edit/Write/Bash/Grep/Glob`; no ToolSearch, web, or nested Agent). It can't pull deferred MCP/browser schemas into context mid-run, can't fan out, and stays on the brief. Note: a tool allowlist **gates access, it does not remove static schema injection** (verified against Claude Code docs), so this is a focus/containment lever, not a big static-context cut. Route implementation/mechanical tasks here via the Agent tool's `subagent_type`.
5. **Project connector/plugin scoping** (`.claude/settings.json`) — `disableClaudeAiConnectors: true` (this repo uses none — Square/Supabase via `fetch`/`supabase-js`, GitHub via `gh`, deploy via `vercel` CLI) and `enabledPlugins: { playwright: false, skill-creator: false }`. Caveat: these knobs are confirmed to *gate* access; the docs don't promise they shrink injected context — **verify the actual saving with `/context` before/after**. The ~10k skill-directory tax (156 installed skills) and the app-connector MCP names are the targets.
