---
name: feedback_audit_trigger_needs_id_column
description: "audit_trigger_fn() requires an `id` column — attaching it to a composite-key table breaks every INSERT with 42703, and no test or review catches it"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e49d81a1-294a-41a5-9d88-81d47b414a19
  modified: 2026-07-31T03:03:28.652Z
---

`public.audit_trigger_fn()` (20260609_baseline.sql) assigns
`v_record_id := case when tg_op = 'DELETE' then (old.id)::text else (new.id)::text end`
**unconditionally**. Attach it to a table that has no `id` column — e.g. one
whose primary key is purely composite — and the FIRST INSERT dies with:

```
42703: record "new" has no field "id"
```

**Why:** this happened on `balance_sheet_account_sources`, whose key is
deliberately `(chart_of_accounts_id, provider_key)` because an account draws on
several providers. The migration created the tables, then its own seed block hit
the trigger and aborted. The result was the worst possible shape: tables present,
**zero seed rows**, feature completely inert, and no error visible after the
fact. A partial apply is indistinguishable from a full one from the outside.

Nothing caught it: 2500+ tests pass against fake Supabase clients that never
fire a trigger; CI never touches a database; two rounds of independent Opus
review read the SQL without executing it; and the parity script only ever READ
balances. **The first evidence was applying it to production.**

**How to apply:**
- Any table getting `audit_trigger_fn()` needs an `id` column. If the real
  identity is composite, add a surrogate
  `id uuid not null default gen_random_uuid()` and keep the composite key as
  the primary key — that is what the fix did.
- After ANY migration with seed data, verify by querying the seeded table, not
  by trusting the apply. `select count(*)` on every table the migration inserts
  into. See [[feedback_prod_db_migration_authorization]].
- Related transport hazard: the Supabase dashboard SQL editor **silently
  truncated** a ~180-line paste mid-function, so the closing `$$` never arrived
  and the error read as "unterminated dollar-quoted string". Keep hand-run SQL
  small and free of dollar-quoting where possible, or use `psql -f`.

Related: [[project_balance_sheet_gl_mapping]],
[[feedback_link_migration_files_directly]].
