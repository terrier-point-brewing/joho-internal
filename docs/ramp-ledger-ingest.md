# Ramp unified ledger ingest — spike findings & design basis

Investigation basis for making the **finance → Transactions** tab the single, drift-free
source for all statements. Findings come from `scripts/ramp-api-spike.mjs` run against live
Ramp data (read-only). Raw dumps land in `ramp-spike-output/` (gitignored — live financials).

## TL;DR

- **Scopes are already granted** on the client-credentials app — `bills:read`, `banking:read`,
  `transfers:read`, `accounting:read`, etc. all mint tokens today. The only code change is adding
  them to `RAMP_SCOPES` in `lib/ramp.ts`. No Ramp *read* permission change is required from you.
- **Bills** code to a GL account exactly like card transactions → the existing auto-map path works.
- **Bank-account lines** (`/banking/syncable-transactions`) are the operating ledger (Gusto, Erie,
  interest, transfers). They carry **no GL coding** — they must be classified by
  `description` + counterparty, not by GL.
- The real drift hazard is **double-counting bill/card settlements** that also appear as bank
  outflows. Classification + de-dup is the heart of this build.

## What each Ramp resource returns

### `/transactions` (card spend — already ingested)
GL account lives in `accounting_field_selections[].category_info.type === "GL_ACCOUNT"`.
The selection element holds `name` (full `Parent:Child:Leaf` account), **`external_code` = the
QuickBooks account number** (e.g. `5230`), and `external_id` = a long internal id.

> **Latent bug found:** `extractGlAccount` reads `external_id` as the "code", so it stores the
> internal id (`1150040031`) instead of the QB number (`5230`). Number-matching in
> `matchAccountToCoa` therefore never fires today — it silently falls back to name matching. Fix:
> prefer `external_code` for `external_account_code`. Improves auto-map precision for txns **and**
> bills at no risk (name fallback stays).

### `/bills` (bill pay — to be added → `expenses`)
- `amount` = `{ amount, minor_unit_conversion_rate, currency_code }` (same `parseAmount` helper).
- `vendor.name` → merchant, `issued_at`/`accounting_date`/`due_at` dates, `memo`/`vendor_memo`.
- `status` = `OPEN` | `PAID`; `approval_status`; `status_summary` (e.g. `PAYMENT_COMPLETED`).
- **GL coding is per `line_items[]`** (top-level `accounting_field_selections` is `[]`). Same
  `GL_ACCOUNT` shape as txns. `extractGlAccount` works once it reads line-item pools (it already
  does) — but see the split-coding decision below.

### `/banking/syncable-transactions` (operating-account ledger — the new source)
Fields: `id, date, description, amount, source_account_name, destination_account_name,
treasury_transfer_type, sync_status, entity_id`. **No `accounting_field_selections`.**

Observed `description` values (the primary classifier): `Withdrawal`, `Deposit`, `Interest`,
`Vendor Payment`. Counterparty is in `source_account_name` / `destination_account_name`
(`GUSTO`, `ERIE INS GROUP`, `Operating Account`, `Investment Account`, …).

> `treasury_transfer_type` is `WALLET_TRANSFER` on **every** line — including interest and vendor
> payments — so it is **not** a usable discriminator. Direction + nature come from `description`
> and which side is our own account.

### `/banking/accounts` & `/transfers`
`accounts` → `{ id, name, account_type }` (`Operating Account`/`WALLET_ACCOUNT`,
`Investment Account`/`MANAGED_PORTFOLIO_ACCOUNT`) — the set of *own* accounts, used to detect
internal transfers. `transfers` → sparse `{ amount, bank_account_id, payment_id, status }`;
likely the cash side of bill/card payments (candidate join key for de-dup).

## Classification model (draft — validate on more data)

Every ledger row gets a `flow_type` and a derived `affects_pl`. Routing to the two tables:

| `description` + counterparty | `flow_type` | `affects_pl` | table |
|---|---|---|---|
| `Interest` (→ own account) | `interest_income` | yes (income) | bank ledger |
| `Withdrawal`/`Deposit` between **own** accounts | `internal_transfer` | no | bank ledger |
| `Vendor Payment` (settles a Ramp bill) | `bill_settlement` | no (bill already booked) | bank ledger |
| card autopay / balance payment | `card_settlement` | no (txns already booked) | bank ledger |
| `Withdrawal` to **external** party, no bill/card behind it (GUSTO, ERIE) | `operating_expense` | yes | **expenses** |
| anything unmatched/ambiguous | `unclassified` | — | bank ledger, flagged for review |

Two hard parts:
1. **De-dup / reconciliation.** A `Vendor Payment` almost always settles a bill already ingested;
   a card autopay settles card txns already ingested. Booking the bank line *and* the bill/txn =
   double count. Default rule: `Vendor Payment` and card autopay are **settlements, excluded from
   P&L**; only direct external debits with no matching bill/card become expenses. Needs a matching
   step (vendor/amount/date, possibly via `transfers.payment_id` ↔ `bill.payment`).
2. **No silent drops.** `unclassified` must surface in the UI for manual coding — never silently
   omitted (that *is* drift) and never silently booked as expense.

Bank lines are uncoded, so they need a **counterparty → chart-of-accounts** rule table
(`GUSTO → Payroll`, `ERIE → Insurance`), parallel to the GL-based `expense_account_mappings`.

## Two-table structure — assessment

Proposed: `expenses` = card + bill + true-direct-debit operating expenses; new table = all other
bank money movement (interest, transfers, settlements, deposits).

**Works**, with these guardrails:
- The new table still carries `flow_type` + `affects_pl` because it holds **income** (interest),
  not just non-P&L rows — statements read income from it too.
- Classification runs at ingest and decides the table. A re-classified row must move tables
  cleanly (delete-then-insert keyed on `(source, source_transaction_id)`), or accept that moves are
  rare and handle explicitly.
- `unclassified` lives in the new table (visible), never in `expenses`.

*(Alternative considered: one physical ledger table + `flow_type`, with "Expenses" as a filtered
view. Fewer moving parts and a literal single basis for statements. The two-table split is fine if
you prefer physical separation — noted so the plan can go either way.)*

## Decisions locked

- **Sign convention:** accounting style — amounts signed by cash direction (outflow negative,
  inflow positive), **negatives rendered in brackets** `(1,234.56)`. Bank amounts arrive unsigned;
  sign is derived at ingest from `description`/direction. Existing `expenses` rows (currently
  positive = spend) migrate to negative for one coherent convention.

## Open design questions for the plan

1. **Bill split coding:** bills carry GL per line item and can split across accounts. Store **one
   expense row per bill line item** (accurate for statements) or one per bill (simpler, loses
   splits)? Recommend per-line-item.
2. **Table name:** keep physical `expenses` (less churn) vs rename to a ledger name.
3. **De-dup mechanism:** confirm the `transfers.payment_id` ↔ `bill.payment` join so settlements
   match reliably instead of fuzzy vendor/amount matching.

---

## Ramp scope & webhook changes you implement separately

**Reads — already done.** The spike confirmed the app already grants every needed read scope, so
no Ramp dashboard change is required to read bills/banking/transfers. In code, extend `RAMP_SCOPES`
in `lib/ramp.ts` to request them:
`… bills:read banking:read transfers:read accounting:read`.
(If you ever rotate to a more restricted app, re-tick these under **Ramp dashboard → Developer →
your API app → Scopes**; client-credentials tokens can only request scopes the app is granted.)

**Webhooks — optional, for near-real-time.** The daily cron already covers bills + bank lines on a
trailing window, so webhooks are an enhancement, not a blocker. To wire them:
1. Confirm the event type strings Ramp emits for bills and banking (not in the public reference —
   check **Developer → Webhooks** event catalog, or create a test subscription and observe).
2. Subscribe the existing endpoint (`/api/webhooks/ramp`) to those events (dashboard or
   `POST /developer/v1/webhooks`), reusing the current HMAC secret.
3. Extend `isReconcilableRampEvent` to also match `bill.*` / banking event prefixes.
