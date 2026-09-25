---
name: project_tax_gl_model
description: "How TPB's taxes are meant to sit in the GL — excise expense-when-paid, sales tax liability-only — plus the mapping traps that miscode payments"
metadata: 
  node_type: memory
  type: project
  originSessionId: 173f2361-1ae6-45e0-a9b8-aafb08bfe855
  modified: 2026-07-30T13:31:24.543Z
---

Decided 2026-07-29 with the user, after they questioned whether sales tax should
run gross through the P&L.

## The rule

**A tax hits the P&L if and only if TPB is the taxpayer.**

- **TPB is the taxpayer** → P&L. Excise (`6451`), licences (`6454`), payroll
  taxes (`6130`). If rebilled to a contract client, the rebilling is genuine
  revenue (`4330 Pass-Through Excise Tax`).
- **TPB is a collection agent** → balance sheet only, never P&L. Sales tax
  (`2210`/`2220`/`2250`). This is what PR #286 built and it is correct — the
  liability model IS the accurate cash-flow picture; grossing it up would only
  route the same dollars through two extra accounts.

## User's chosen treatment: keep it simple (cash-ish)

They explicitly accepted the timing mismatch in exchange for simplicity:

- **Excise: expense to `6451` WHEN PAID.** No accrual, no excise liability.
  Income `4330` lands when the client is invoiced, expense when NC/TTB cashes
  the payment — different months. `2260 TTB Payable` therefore stays unused.
- **Sales tax: unchanged** — liability only.

Consequence to expect: `4330` and `6451` will not tie within a month, and
`6451` should end up LARGER than `4330` (excise on TPB's own taproom/
distribution beer is never rebilled).

## Live state as of 2026-07-29

- `4330` = **+$2,085.45** across 20 invoice lines (all `category =
  pass_through_taxes`, notes name the authority: "Excise Tax — TTB (3.10 bbls)").
- `6451` = **$0.00**. No excise expense has EVER been recorded, so income is
  overstated. No TTB payment exists anywhere in Ramp.
- Three payments sit on `2220 NC DOR Payable`: −$118.83 Wake (2026-06-17),
  −$1,296.50 (2026-06-18), −$1,031.94 (2026-07-20).

## ⚠️ Mapping traps that caused the miscodes

- **`NC DEPT REVENUE → 2220` counterparty rule auto-codes EVERY NC payment to
  sales tax.** NC DOR collects both sales tax and beer excise (B-C-710), so
  excise payments silently pay down a sales-tax liability. The rule is
  deliberate (`auto_matched = false`), and it will keep doing this.
- **The app has no concept of one payment covering two taxes.** Every mapping
  mechanism assigns an expense to exactly ONE account, so a mixed NC DOR payment
  can only ever be coded wrong. Fix per payment via the **Manual Split** panel on
  Finance → Transactions → Expenses — a manual split pins `mapping_source =
  'manual'`, which stops the auto-map overriding it.
- The $1,296.50 was `mapping_source = manual` (hand-picked, whole amount to
  sales tax). The $1,031.94 was `rule` (and is probably right — within $0.49 of
  June's sales tax). The Wake $118.83 says `rule` but has a NULL
  `counterparty_key` and **no rule points at 2220** — unexplained; its memo
  ("Business tax and licensing fee payment") suggests it may be a licence fee
  (`6454`), not a tax at all.
- **Counterparty rules cannot be created by hand** — no add button; a row only
  appears after that vendor's first Ramp sync. So the TTB rule can't exist until
  a TTB payment lands.

## Chart-of-accounts notes

- `6452 Sales Tax Paid` should be renamed **"Sales & Use Tax on Purchases"** —
  under the rule it can only mean use tax TPB bears on its own buying, never a
  remittance of collected tax. Currently empty, i.e. a trap waiting to be sprung.
- Sales tax TPB *pays* on its own utility bills (Duke $104.12, Enbridge $40.13)
  is correctly left inside `5140 Brewery Utilities` — that's a real cost and
  keeping it with the bill reflects the true cost of the utility.
- Refundable deposits TPB PAYS (utility, landlord) are an **asset**, not an
  expense. Create `1310 Security Deposits Paid`. ⚠️ Do not confuse with
  `2420 Equipment Deposits` / `2430 Contract Brewing Deposits`, which are
  LIABILITIES — customers' money TPB holds. Opposite direction, adjacent names,
  same dropdown.
- QBO's detail type for these is **Security Deposits** under account type
  **Other Assets** — now supported by the app (PR #298).

Related: [[project_sales_tax_in_revenue]], [[project_other_assets_account_type]],
[[project_excise_channel_liability]], [[project_tips_balance_sheet_passthrough]].
