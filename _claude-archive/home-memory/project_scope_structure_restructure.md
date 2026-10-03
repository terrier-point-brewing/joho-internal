---
name: project-scope-structure-restructure
description: "2026-07-28 permission scope tree restructured onto three orthogonal axes; MERGED as #285 with both migrations applied"
metadata: 
  node_type: memory
  type: project
  originSessionId: 62b1ff5c-993a-4457-bad8-2cdce3210530
  modified: 2026-07-28T19:02:18.378Z
---

**MERGED as PR #285**, squash commit `994c7f0`. Branch and worktree cleaned up. Both migrations applied. Registry 20 → 27 keys. Master artifact: `docs/superpowers/specs/2026-07-28-scope-structure-analysis.md` (surface × domain matrix, decisions, verification limits); handoff brief with the 10 binding decisions is `2026-07-28-permission-model-handoff.md` in the MAIN worktree.

✅ **Migrations 20260825 + 20260826 APPLIED by Will 2026-07-28** and verified: jeffkliao holds 8 rows (`settings`→`org`, `tax`→`finance.tax`, synthesised `catalog: read`); role bundle seed = 24 rows (admin 1 / brewer 13 / manager 7 / viewer 3) matching ROLE_BUNDLES; `effective_grant_level` spans both grant sources. They were applied BEFORE the merge; that window is now closed.

⚠️ Supabase SQL Editor prompts **"run and enable RLS" on any `create table` in public** even when the migration already enables it. Answering yes is a no-op; verify with `pg_class.relrowsecurity` + `pg_policies` rather than assuming a follow-up migration is needed.

✅ **Tips-branch conflict RESOLVED** (it merged as #283/#284 mid-session). The rebase silently gave the moved `app/settings/payroll/departments/page.tsx` its PRE-tips content — the tips-liability GL picker was gone and everything still compiled and passed. Fixed by taking `origin/main`'s file content for the new path and re-applying the two path edits. **Durable lesson: on a rebase that both MOVES and MODIFIES a file, grep the moved file for the other branch's feature — green tests prove nothing here** (see [[feedback_subagent_content_fabrication]]).

**Design invariant:** the tree models DOMAIN only. Depth is the level ladder (a settings screen is a domain's `manage` face — there is no `settings.*` family). Placement: `<section>.access` for admission, leaf for one consumer, top-level for two or more (`payroll`, `catalog`), sub-leaf for finer-than-parent (`finance.tax.filing`). Every past defect came from one axis borrowing another's mechanism.

**Decisions locked:** manager gets no finance access and their `tax` grant was REMOVED (unreachable — every tax screen is under `/finance`); manager holds no `manage` anywhere, which is what keeps the settings hub empty for them; manager loses Square Item Mappings editing, accepted because phase 5 makes it restorable via UI; `catalog` will never grow a second catalog concept; brewer got `finance.tax.filing: read` as a leaf-only grant (sibling-leaf rule — confers nothing else in finance).

**Non-obvious gotchas worth keeping:**
- Deny targets must be **scope-less** surfaces. `/` redirects to `/taproom/performance`, so bouncing a taproom-less user there loops forever. `requirePage()` defaults to `/settings/account`.
- `createSupabaseAdminClient()` **throws** on missing `SUPABASE_SERVICE_ROLE_KEY` — an `{ error }`-only fallback misses it and 500s every authenticated request. A test caught this in `roleBundles.server.ts`.
- CAP entry **names** are a stable API: 212 `legacy-matrix.ts` rows key on them, so a re-key changes the `scope:` coordinate and leaves the name alone → zero fixture churn.
- `effective_grant_level()` originally short-circuited on `get_my_role() = 'custom'`. Making bundles data required unioning role rows in, or Postgres denies what the app allows — the same divergence [[project_rls_grant_aware_policies]] fixed, from the other side.
- The `admin` role bundle is intentionally **immutable** in the editor; it's the recovery path.

**Guards keeping this honest:** `check-permissions.mjs` (now enforced in CI — it existed and was clean but had never run there), `legacy-matrix.ts` intentionalChange rows 30 → 52, and `roleBundleSeedParity.test.ts` which parses the seed out of the migration so it can't drift from the constant. See [[feedback_frozen_tests_as_equivalence_gate]].

⚠️ **PR #287 (`refactor(settings): one level of subtabs, groups in the sidebar`) landed right after and reworked the settings nav this branch built** — check it before trusting any nav detail here.

**Verification limit:** browser checks proved boot + routing only — `proxy.ts` short-circuits to `/login` without a session, so no gated layout was exercised end-to-end. Gate semantics rest on the 2217 tests.
