---
name: feedback_prod_data_correction_dryrun
description: "Dry-run a prod data-correction migration by wrapping it in a DO block that RAISEs the verification output, so it rolls back but still returns the numbers"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 0b5f14c5-6f0e-4c9a-b392-5df475c40c6a
  modified: 2026-07-29T21:08:41.857Z
---

Before applying any data-correction migration to the prod Supabase project, dry-run it with a `DO` block that performs every statement, builds a verification payload, then `raise exception` to carry that payload out:

```sql
do $$
declare v text;
begin
  -- ...every statement from the migration...
  select jsonb_pretty(jsonb_build_object('exhaustion', ..., 'cold_storage', ...)) into v;
  raise exception E'DRYRUN_OK\n%', v;
end $$;
```

The exception aborts the transaction (nothing persists) while the error message returns the post-change numbers. Confirm the rollback with a follow-up query asserting the pre-change values are still there.

**Why:** the Supabase MCP `execute_sql` returns only the **last** result set, so the obvious `begin; ...; select <verify>; rollback;` swallows the verification output — and dropping the `rollback` to see the numbers would commit the change. The RAISE trick is the only way to get both properties at once. It caught the exact per-row deltas on [[project_b035_wiggo_packaging_double_entry]] before anything touched prod.

**How to apply:** dry-run → show the user the before/after table → get explicit OK ([[feedback_prod_db_migration_authorization]]) → stage a rollback script with **captured absolute values** (not deltas, which double-apply if re-run) → apply. Then re-query prod and paste real output; never assert success from the dry run alone ([[feedback_frozen_tests_as_equivalence_gate]] is the analogous rule for refactors).
