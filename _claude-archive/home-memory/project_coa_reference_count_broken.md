---
name: project_coa_reference_count_broken
description: coa_reference_count 42703s in prod — the per-row CoA delete in Settings is already broken; caused by a grandfathered 20260802 prefix collision
metadata: 
  node_type: memory
  type: project
  originSessionId: e49d81a1-294a-41a5-9d88-81d47b414a19
  modified: 2026-07-30T20:20:30.547Z
---

⚠️ **Live prod bug, found 2026-07-30, NOT fixed.** Calling
`coa_reference_count` returns:

```
42703: column "bs_chart_of_accounts_id" does not exist
```

So the per-row **Delete** in Settings → Chart of Accounts is already failing —
the route calls this RPC to build its "in use" 409, gets an error instead, and
surfaces a 500. Independent of any recent feature work.

**Cause:** `20260802_coa_reference_count.sql` references
`square_catalog_variations.bs_chart_of_accounts_id` / `pl_chart_of_accounts_id`,
while `20260802_retire_deposit_recognition_columns.sql` drops them. Both share
the `20260802` prefix, which is **grandfathered at 2 in
`scripts/check-migrations.mjs`**, so the guard reports clean — and the Supabase
CLI, which keys version on the digits before the first `_`, treats applying
either as applying both. Confirmed against prod: neither column exists on
`square_catalog_variations` (only `chart_of_accounts_id`,
`chart_of_accounts_id_pos`, `chart_of_accounts_id_invoice`).

**Why it matters beyond the delete button:** any migration that does
`create or replace function coa_reference_count(...)` must restate the whole body,
and Postgres validates `language sql` bodies at CREATE time — so it will **abort
on prod**. PR #300 originally extended this function to add a `manual_entries`
arm and had to drop that section for exactly this reason.

**How to apply:** fixing it needs a decision about which columns are real — were
the deposit-recognition columns meant to survive `20260615_deposit_recognition.sql`,
or is `retire_deposit_recognition_columns` the intended end state? Rewrite the
function body to match, in its own migration with a full `YYYYMMDDHHMMSS` stamp.
While there, add the missing `manual_entries` arm.

Related: [[project_balance_sheet_gl_mapping]],
[[project_deposit_recognition_retirement]], [[project_draft_swap_tap_transitions]]
(the prefix-collision gotcha).
