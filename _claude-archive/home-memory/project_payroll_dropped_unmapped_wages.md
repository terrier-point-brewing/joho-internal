---
name: project_payroll_dropped_unmapped_wages
description: computeGlBucketTotals silently drops wages for an unmapped department — cost $750.60 of real May payroll; the upload path can still do it
metadata: 
  node_type: memory
  type: project
  originSessionId: 173f2361-1ae6-45e0-a9b8-aafb08bfe855
  modified: 2026-07-30T13:31:42.352Z
---

Found 2026-07-29 while diagnosing why the tips backfill's preview gate blocked
two periods. Fixed the gate (PR #294); **the upload path that caused it is NOT
fixed.**

## The bug

`computeGlBucketTotals` (`lib/payroll/gustoParser.ts`) **skips an employee's
gross entirely when their department has no GL mapping** — it records the name
in `parsed.unmappedDepartments` and `continue`s — while still accruing their
employer tax. Nothing blocks or warns at upload time.

All six Gusto reports were uploaded in one sitting on 2026-07-17, and the
"Sales & Admin" department mapping was created at **00:56:01**, partway through:

| Period | Uploaded | |
|---|---|---|
| 2026-05-04 | 00:53:58 | **2m03s BEFORE the mapping existed** |
| 2026-05-18 | 00:55:37 | **24s BEFORE** |
| 2026-06-01 | 00:56:35 | after |
| 2026-06-15 | 00:57:11 | after |
| 2026-06-29 | 00:57:43 | after |
| 2026-07-13 | 2026-07-27 | after |

Both May periods permanently lost that employee's wages — **$350.60 and
$400.00**. Their stored `payroll_gl_report_totals` carry NO
"Sales & Administrative Wage" row at all; every later period does. **May payroll
has been understated by $750.60 in the GL since 17 July.** The tips backfill
corrects it.

## The gate bug this surfaced (PR #294, merged)

`GlBackfillPanel`'s preview gate required `total(before) === total(after)`,
which is **unsatisfiable by construction** — so the tips backfill has never been
runnable through the UI, which is the real reason it sat un-run.

`before` reads stored totals where every pre-backfill row carries
`bucket_kind = 'wages'` (the 20260824 column default, which backfilled nothing),
and gustoParser has always excluded paycheck tips ("Never folded into
grossAmountCents"). Tips were never there to reclassify OUT of — the backfill
ADDS a tips bucket, so the grand total is SUPPOSED to grow by exactly the tip
amount. Confirmed: on four of six periods `after − before` equals the Tips
column to the cent.

Correct invariant: **non-tip payroll (wages + employer_tax) unchanged**; tips
are new. Also stays correct on a re-run, where `before` already carries tips.

`backfillGlReports` now returns `recoveredAccounts` — wage accounts present in
the re-parse but absent from the stored totals, inferred from the data since no
record of past mapping state is kept. Restricted to `wages` buckets: employer
tax and tips are company-wide and accrued regardless of mapping, so counting
them would make EVERY period look "explained" just because tips are new. A
delta exactly equal to recovered wages is a readable note that permits the run;
anything unexplained still hard-blocks.

## ⚠️ Still open

The upload path can do this again. Nothing refuses an upload with unmapped
departments, or surfaces `unmappedDepartments` prominently. Worth a follow-up.

Related: [[project_tips_balance_sheet_passthrough]], [[project_backfill_panels_settings]].
