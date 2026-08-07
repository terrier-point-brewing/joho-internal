# Balance methods — handoff for integration work

Read this before building a balance-sheet integration. It is written so a fresh
session needs nothing from the conversation that produced the scaffolding.

**Scaffolding branch:** `claude/balance-method-scaffolding`
**Migrations, both APPLIED to production on 2026-08-01:**
`20260912110000_balance_methods.sql`, `20260913090000_balance_integration_connections.sql`

Note this repo's file stamps are an ordering convention only — Supabase records
its own version when a migration is applied, so the two never match. Do not
"fix" that. Do check `node scripts/check-migrations.mjs --strict` against a
freshly fetched `main` before choosing a stamp: CI validates the MERGE result,
so a stamp that is unique locally can still collide with something merged while
you were working. Suggested free stamps: Ramp `20260914090000`, Square
`20260915090000`, Plaid `20260916090000`.

---

## 1. What is already built

| Piece | Where |
|---|---|
| Provider registry (atomic calculations) | `lib/finance/balances/registry.ts` |
| Method registry (what a user selects) | `lib/finance/balances/methods/registry.ts` |
| The six built-in methods | `lib/finance/balances/methods/definitions.ts` |
| Snapshot + source expansion | `lib/finance/balances/snapshot.ts` |
| Connection store + daily capture | `lib/finance/balances/connections.ts` |
| Settings screen + explainer panel | `app/settings/finance/balance-sheet-accounts/page.tsx` |
| Frozen production parity fixture | `lib/finance/balances/__fixtures__/goldenBalanceSheet.ts` |
| Statement isolation gate | `scripts/check-statement-isolation.mjs` |

## 2. The three concepts, in order

**Provider** — computes one number from one source. `compute(ctx) => number | null`.
Returning `null` means "cannot determine", which is different from `0`.

**Method** — what appears in the Settings dropdown. Declares an ordered list of
steps, each naming a provider plus the plain-English copy shown to an operator.
A method is always the *complete* calculation for an account.

**Step key** — the string a value is stored under in
`gl_account_balances.contributions`. Defaults to the provider key. **Treat it as
a published contract**: renaming one orphans historical data silently.

## 3. Building an integration — the five pieces

### a. A provider
Register in `lib/finance/balances/providers/<name>.ts`, add the import line to
`providers/index.ts`. Read its connection via
`resolveConnection(supabase, ctx.config)`, which returns `null` when the account
is not linked yet — return `null` too, never throw.

### b. A method
Add to `methods/definitions.ts`. `kind: "calculation"`. Give it an `appliesTo`
so it is only offered on sensible accounts (bank accounts are
`statementSection === "bank"`), and declare what it needs in `setup`.

**`setup` is the ONLY thing you implement for configuration handling.** It is a
list of fields, and a connection is just one kind of field:

| Kind | For | Stored in |
|---|---|---|
| `connection` | Linking an external account. Declares `provider` and `connect: "discover" \| "authorize"` | `config.connectionId` |
| `operatorBalance` | A figure only a person can supply, asked for **once** at setup | a `manual_entries` balance row |
| `account` | Another chart-of-accounts row, narrowed by `sections` | `config.<key>` |
| `user` | A person in this business — who is responsible for something | `config.<key>` |
| `select` / `number` / `text` / `date` | Any other prerequisite — a rate, a term, an in-service date | `config.<key>` |

`operatorBalance` is narrower than it looks and is easy to reach for wrongly.
It means "ask a person for a figure ONCE, because the calculation cannot start
without it" — Square's anchor, which has nowhere else to come from. It does
**not** mean "a person supplies this every month". Manual entry needs a figure
every month and declares no `operatorBalance` at all, because typing that
figure is the recurring job, not a setup step: a dollar input on the Settings
screen breaks that screen's own rule that Settings holds rules and Transactions
holds values.

Two config keys are reserved and read **by name** outside the panel:
`connectionId` (every connection resolver) and `dueDaysAfterMonthEnd`
(`CLOSE_DUE_DAYS_KEY`, a per-account close deadline read by `closeTasks.ts`).
Both are held to their name and shape by the conformance suite.

From that declaration, generically: Settings renders the field inside the
account's own row, stores the answer, says in plain English what is still
outstanding, refuses to call the account configured until every required field
is answered, and — for a `connection` — resolves it and renders its health.
There is no per-integration screen, no per-integration route and no
`describeConnection` to write.

Things are **derived** from the declaration, never flagged separately — one
fact in two places is one fact that can disagree with itself:

- `connectionProviderOf(method)` — from the `connection` field. What the
  capture planner and the picker read.
- `responsibleUserIdOf(method, config)` — from the `user` field. Who the
  month-end alert is addressed to.
- `requiresMonthEndBalance(method)` — from the **steps**, not the setup: a
  method raises a month-end close task exactly when one of its steps runs a
  provider with `kind: "manual"`, because that provider reads a
  `manual_entries` balance dated to the month being computed and returns null
  until somebody types one. This was read off `operatorBalance`'s presence
  until manual entry stopped declaring one; had it not moved, every manual
  account would have silently stopped being chased.

Setup copy is held to the same editorial standard as step descriptions and is
enforced by the same conformance suite. It is read by someone who is stuck, so
it matters more, not less.

### c. A connection row
`integration_connections` holds what you are connected to plus any
per-connection secret. **Never** select `credentials` into a response —
`listConnections`/`getConnection` cannot, `getConnectionWithSecrets` is the
deliberate exception.

Every integration gets a row even when it has no secret to store, because the
row is also what records *which* external account maps to the GL account and
what the Settings status line reads.

**Where a credential belongs — per-connection in the store, app-level in env.**

| Secret | Home | Why |
|---|---|---|
| Plaid `access_token` | `credentials` | Minted per bank link at runtime. Cannot be an env var. |
| Square access token | env | One token for the business. |
| Ramp client id/secret | env | One OAuth client for the business. |

Do **not** refactor Ramp's existing env credentials into this table. Three
reasons, in order of weight:

1. `lib/ramp.ts` has ten consumers and one of them is
   `app/api/finance/pl/route.ts`. Changing how it authenticates means touching
   the credential path under the P&L, which is settled and verified.
2. An app-level secret in an env var is not in the database, not in backups and
   not reachable by SQL. Moving it into a table is a downgrade, not a tidy-up.
3. Sync health for `ramp-expenses-sync` and `finance-sync` already lands in
   `cron_runs` via `runCronJob` and shows under Settings > Cron Jobs.
   Duplicating it here would give two places to check and two to disagree.

The Ramp balance method still gets a connection row — with an empty
`credentials` object — so account selection and the Settings status line work
the same way they do for the other two.

### c2. Wiring a connection up

Already built and shared — do not rebuild any of it:

| Need | Use |
|---|---|
| List / create / update / delete a connection | `PUT`,`GET`,`DELETE /api/finance/balance-connections` |
| List candidates, sign in, finish, test | `/api/finance/balance-connections/{provider}/{candidates\|authorize\|complete\|check}` |
| Attach one to a GL account | The setup panel on Settings > Balance Sheet Accounts |
| Read it inside `compute()` | `resolveConnection(supabase, ctx.config)` |
| Store a secret | `writeCredentials()` — server-side only, unreachable by any route |
| Report a read outcome | `recordSyncResult()` |
| Write an operator figure | `setOperatorBalance()` / `POST /api/finance/balance-sources/operator-balance` |

What you DO build is one implementation of `SetupHandler`
(`lib/finance/balances/setup/types.ts`), registered in `setup/index.ts`. It
declares only what actually differs between services:

* `readiness()` — can the app talk to this service at all? Must never throw and
  never call the network. This is what makes an unconfigured integration say so
  instead of surfacing a raw `Missing required environment variable`.
* `candidates()` — for a `discover` flow.
* `authorize()` / `complete()` — for an `authorize` flow. The credential is
  minted inside `complete` and stored with `writeCredentials`; it is in no
  request and no response, so it cannot reach a request log. The generic
  connections route rejects `credentials` with a 400 for the same reason.
* `check()` — optional, and should run the REAL read the provider does. A
  lighter check can pass while the real read fails, which is the one outcome a
  validation exists to rule out.

**No new screen, no new route, no new nav entry.** Three integrations each built
all three and the results looked nothing alike; that is what this shape exists
to prevent.

### d. Daily capture, if the source cannot be asked about the past
Ramp *can* return dated history. Plaid **cannot** — its balance endpoint answers
"right now" and takes no as-of date. For those, write a daily row with
`recordDailyBalance` and have the provider read it with `readDailyBalance`.

Lookup is exact-date only by design; falling back to an earlier capture would
present a stale balance as a month-end figure. Record the balance under **the
date it represents**, not the date you fetched it — a real-time read taken on
the 1st is an intraday balance for the 1st.

**Built by the Plaid branch.** `app/api/cron/balance-capture/route.ts` runs
daily at 02:00 UTC — late evening at the brewery on the day it records, so the
month-end figure is a near-closing balance and lands seven hours before the
09:00 `balance-close` run that reads it. Wrapped in `runCronJob`, registered in
`vercel.json` and `lib/cron/registry.ts`.

Its core, `lib/finance/balances/dailyCapture.ts`, is parameterised by connection
provider and by a reader function, and imports nothing from `lib/plaid`.
**Square should register a second reader there rather than build a second
cron** — an anchor-plus-movement balance has the same "only evaluable as of
now" property. Ramp needs none of it. The Plaid reader is
`lib/finance/balances/plaidCapture.ts`, which is the only caller that touches a
stored bank credential.

### e. Tests
Co-locate `*.test.ts`. The conformance suite in
`methods/definitions.test.ts` will automatically enforce, for your method:
- every step resolves to a registered provider
- every step has a full-sentence description over 40 characters
- no description contains a snake_case identifier, a code call, or a provider key
- the label is sentence case

## 3b. Running Ramp, Plaid and Square in parallel

All three are designed to run at once, on separate branches. Three rules keep
that true.

**Migration stamps.** Suggested: Ramp `20260914090000`, Square `20260915090000`,
Plaid `20260916090000`. Re-check with `node scripts/check-migrations.mjs --strict`
against a **freshly fetched main** before pushing. CI validates the merge result,
so a stamp that is unique on your branch can still collide with something merged
while you worked. This has already bitten once.

**Do not reshape `connections.ts` silently.** If your integration needs the
connection store changed, say so prominently in the PR description. Whoever
merges first wins and the others rebase — cheap if it is visible, expensive if
two branches quietly diverge. Plaid is the likeliest to need it, since it is the
only one exercising both stored credentials and daily capture; Ramp exercises
neither.

**Do not edit the Settings page.** A registered method appears there
automatically, and so does everything it declares in `setup`. If you believe you
need to change `app/settings/finance/balance-sheet-accounts/`, that is a signal
the scaffolding is missing something — raise it rather than patching around it.

All three integrations honoured this, and it still cost them: each built its own
Settings screen INSTEAD, so configuring one account meant two screens visited in
the reverse of the order anyone thinks in. Those three screens are now gone and
setup happens in a panel on the account's own row. Not editing this page is
still the rule; the difference is that there is no longer anywhere else to go.

**Shared modules Square has already changed** (merged or in review — rebase onto
them rather than re-inventing):
- `methods/registry.ts` — added an optional `requiresCloseEntry` flag to
  `BalanceMethod`. Purely additive; a method that omits it behaves as before.
  **Superseded:** that flag is gone, replaced by an `operatorBalance` entry in
  `setup`. See §3b.
- `closeTasks.ts` — `ensureTasksForPeriod` now selects every active source and
  filters with `requiresOperatorBalance`, instead of querying
  `provider_key = "manualBalance"` directly. Same result for `manualBalance`;
  methods declaring the flag now also raise a close task.
- `connections.ts` — **unchanged**, as hoped.

Expect small mechanical conflicts in `providers/index.ts` (one import line each)
and `methods/definitions.ts` (one method each). Those are adjacent-line
conflicts, not logical ones. `definitions.test.ts` already asserts built-in
methods by containment so your seventh method does not fail anyone else's build.

Merge in whatever order they finish. There is no dependency between them.

## 4. Rules that are not negotiable

**Sign convention.** Stored values are internal convention: assets positive,
liabilities and equity **negative**. The flip to conventional presentation
happens only in `app/finance/financials/buildTree.ts`. Never touch
`normalizeSign.ts` — it is shared with the P&L.

**Null, not zero.** An account with no determinable balance must produce no row
at all, so it reads as unsourced rather than as a real $0.

**Failure is per-account.** If any step throws, the whole account is skipped and
nothing is written. A stale-but-correct row beats a fresh-but-partial one. GL
2220 is the worked example: accruals alone report −297,509 where the answer is
97,974, with nothing on screen to say it is half an answer.

**Graceful degradation.** A missing table or an unreachable API must leave the
balance sheet rendering. Return `null`; do not throw.

**Statement isolation.** `lib/finance/balances/*` may import from
`lib/finance/financials/*`. The reverse is forbidden and enforced by
`npm run check:statements`, which runs inside `npm run verify`. The only bridge
is `buildBalanceSheetFinancials.ts`.

**Parity.** `npm run verify` must be green, and the golden fixture must still
match. Do not edit the fixture to make something pass — it is a capture of real
production values, and changing it destroys the only evidence the refactor was
safe.

## 5. The three integrations

### Ramp — GL 1030 Ramp Operating (do this one first)

> **Built.** Method `rampBalance`, provider
> `lib/finance/balances/providers/rampBalance.ts`, migration
> `20260914090000_ramp_balance_gl_1030.sql`. Three things it settled that Plaid
> and Square inherit rather than re-decide:
> * ~~A setup flow is a **per-integration** Settings page plus a GET route that
>   lists candidates.~~ **Superseded.** All three did this and the results
>   diverged; setup is now a `SetupHandler` rendered by the shared panel, and
>   the three per-integration screens and nav entries are gone. See §3b/§3c2.
> * `connections.ts` was **not** reshaped. Nothing to rebase around.
> * `BUILT_IN_METHODS` in `methods/definitions.ts` now has seven entries.
>   Appending an eighth is an adjacent-line conflict, not a logical one.

Simplest, and the reference implementation. `treasury:read` is **already** in
`RAMP_SCOPES` in `lib/ramp.ts`; no dashboard change or new credential needed.

```
GET /developer/v1/banking/accounts                       -> find the account id
GET /developer/v1/banking/accounts/{id}/balance-history  -> daily balances
    ?start_date=&end_date=
```

Returns `{ date, amount: { amount, currency_code, minor_unit_conversion_rate } }`
— already in cents. Take the row where `date === periodEnd`. It is the
*available* balance, which may differ from a posted statement balance if
anything is pending on the last day of the month. No daily capture needed,
because the range query covers history.

Bonus: GL 2110 Ramp Card can use `getRampStatements()`, which already returns
`ending_balance`. Statement periods may not align to calendar month ends.

### Plaid — GL 1020 Chase Operating — BUILT
**Trial plan confirmed 2026-08-01**, against Plaid's help centre article "What
is the Plaid Trial plan?": free access to the production APIs with real
financial accounts, Balance and Transactions both included, OAuth coverage
naming Chase explicitly, 10 Production Items (this uses one). Eligibility is
developers in the US or Canada with no pre-existing Production or Limited
Production account — no Plaid account existed, so that holds. The pricing page's
"no free Production tier" refers to the paid plans and does not contradict it.
Two caveats that survive: OAuth access appears 6–24 hours after approval, and
some institutions need extra registration.

`/accounts/balance/get` returns real-time available and current balance and
forces a fresh pull. Constraints:
- **No historical balances.** Daily capture is mandatory.
- Balance cannot initialise Link on its own — open Link with Transactions, which
  also gets you Chase transaction data.
- Synchronous against the bank; can take 30 seconds. Fine in a cron, not in a
  page load.
- `access_token` is per-connection → `integration_connections.credentials`.

What shipped, and two decisions worth knowing:

| Piece | Where |
|---|---|
| Method `plaidBankBalance` | `methods/definitions.ts` |
| Provider `plaidBalance` — reads the capture, never the API | `providers/plaidBalance.ts` |
| Generic daily capture | `dailyCapture.ts` + `app/api/cron/balance-capture/` |
| Plaid reader (the only user of a stored token) | `plaidCapture.ts` |
| API client | `lib/plaid.ts` |
| Link setup flow | `lib/finance/balances/setup/plaid.ts`, rendered by the shared setup panel |

**No schema change.** `integration_connections` and `gl_account_daily_balances`
already carry everything Plaid needs, so the reserved `20260916090000` stamp was
not used and is free for whoever wants it.

**`connections.ts` was not modified.** It was expected to be the branch most
likely to need reshaping — it exercises both stored credentials and daily
capture — and it did not. Ramp and Square do not need to rebase for it.

`current` is stored, not `available`: available nets off holds and pending
debits that have not posted and are not in the books either, so it would open a
difference against the ledger that no reconciliation could explain.

### Square — GL 1040 Square Deposit — BUILT
**There is no balance endpoint.** Verified against the full v2 spec, and
re-confirmed live: `ListBankAccounts` returns metadata only (13 fields, no
balance), and the only `balance` fields anywhere belong to gift cards and
loyalty. The balance must be derived.

`PAYOUTS_READ` is **confirmed present** on the env token — live 200s on both
`/v2/payouts` and `/v2/payouts/{id}/payout-entries`.

Design shipped: **anchor plus movement, re-anchored at each close** — as agreed.
The movement term is not what this section originally specified, because the
live data contradicted the assumption behind it. Corrected below.

**The payouts feed only reports money coming IN.** Every payout the API will
return — asked for from 2021, across every location and every status — carries
`destination.type = SQUARE_STORED_BALANCE`. Card sales settle into a Square-held
balance, so a payout here is an **inflow**, not the outbound leg this section
assumed.

**The feed is also much shorter than it looks.** Asking from 2021 does not mean
five years came back: re-probed 2026-08-01, the earliest payout Square will
return is **2026-05-15**, and there were 1,767 of them by then. So GL 1040 can
never be derived for any month before May 2026 — not for want of a feature, but
because the data does not exist to ask for. Do not plan a historical balance
sheet for this account around it.

Re-probed the same day, deliberately looking for a shape that would contradict
the above rather than confirm it. Nothing did:

| Checked | Found |
|---|---|
| `destination.type` over all 1,767 payouts | `SQUARE_STORED_BALANCE` ×1,767. No `BANK_ACCOUNT`. |
| `payout.type` | `BATCH` ×1,767. No `SIMPLE`. |
| `payout-entries.type`, sampled evenly across the whole history | only `CHARGE`, `REFUND`, `GIFT_CARD_LOAD_FEE` |
| The 8 **negative** payouts | every one a single `REFUND` entry matching to the cent — refund days, not sweeps |
| `/v2/bank-accounts` | metadata only; no balance, no movements |
| `/v2/settlements` (the old endpoint) | `NOT_FOUND` — retired |

Square's payout-entry vocabulary has ~30 values, several of which would
represent money moving out. **None appear in this merchant's data at all.** The
gap is structural: Square models a payout as card sales settling *to* a
destination, and moving money *off* the stored balance is a banking action with
no Connect v2 surface. It is Dashboard-only.

**That does NOT mean money stays on Square.** It does leave: Square holds a
VERIFIED Chase checking account for the business (`ListBankAccounts` — routing
028000121, ending 077, creditable and debitable), and sweeps to it happen.
Transfers off the stored balance are simply **not modelled as payouts**, so they
are absent from the feed entirely. Read "no `BANK_ACCOUNT` payouts" as a limit
of the API, never as evidence about where the money went — an earlier draft of
this section drew exactly that wrong conclusion.

That is good news for the hard half. `amount_money.amount` on a stored-balance
payout is already net of processing fees and refunds, and Square's own totals
reconcile exactly — verified over July 2026: entries gross 4,332,371 − fees
64,092 = 4,268,279 = the sum of payout amounts, to the cent. So money *in* is
one clean number, not payments − refunds − fees assembled by hand. The drift
source this section warned about is gone.

The **outflow** is real, regular, and currently observable nowhere:
- not in the payouts feed — sweeps are not payouts;
- not in the books — GL 1040 carries **zero** postings across every source
  `transactionPostings` reads;
- not from the bank side — **there is no Chase feed in this system yet.** GL
  1020 has no rows of any kind. That is Plaid's half, unbuilt.

So: **balance = last verified balance + net settlements since**, with the
outflow absorbed by re-anchoring, and the drift logged in
`square_balance_reconciliations` (migration `20260915090000`).

**Expect drift to be large and negative** — roughly a month of sweeping, not a
small residual. So the log cannot yet separate "swept to Chase" from "the
derivation is wrong"; what it can flag is drift that is positive or wildly out
of step with the month's takings, which sweeping does not explain. This is a
stated limitation of the account, not an oversight.

### Where the money actually goes, and how to catch it

Established 2026-08-01. The cash makes **two hops**, not one:

```
Square stored balance  ──sweep──▶  Chase ····4077  ──transfer──▶  Ramp Operating (GL 1030)
     (GL 1040)                        (GL 1020)
```

The second hop is already visible: `bank_ledger` carries four `deposit`
rows from `TPB OPERATING FUNDS (···· 4077)` — $46,468.51 in June, $47,983.64 in
July, the same order as Square's monthly takings. That is Chase → Ramp, **not**
Square → Chase, so it is not usable as the outflow term directly. It is
corroboration that the first hop happens, nothing more.

**The first hop is catchable by its ACH descriptor.** A Square deposit lands in
a bank account looking like this:

```
ORIG CO NAME:Square Inc ORIG ID:9424300002 DESC DATE:260723
CO ENTRY DESCR:SQ260723 SEC:PPD TRACE#:021000028611043 EED:260723
IND ID: IND NAME:TERRIER POINT BREWING TRN: 2048611043TC
```

Match on **`ORIG ID:9424300002`** — Square's ACH company id, an exact numeric
token — with `ORIG CO NAME:Square Inc` as the fallback. Do not match on
`CO ENTRY DESCR:SQ…`, whose suffix is a date, nor on the trace number, which is
per-transaction. See `lib/finance/balances/squareSweeps.ts`.

**The feed is now BUILT.** `/transactions/sync` in `lib/plaid.ts` (cursor-based,
per-page commit, cursor in `integration_connections.config`), imported by
`balances/plaidTransactionSync.ts` from the `bank-transactions-sync` cron at
03:00 UTC, read back by `balances/bankTransactions.ts`, and split into the
reconciliation by `squareDrift.ts`. Migration
`20260916090000_bank_ledger_plaid_source.sql`.

Three things it settled that anything touching bank data inherits:

**Chase rows live in `bank_ledger`, discriminated by `source`.** Not a
parallel table. The table already carried `source` and `source_transaction_id`
with a unique constraint across the pair. The name stays — ten modules read it,
one under the verified P&L, and a rename buys nothing `source` does not.

**They are imported EXCLUDED from the general ledger.** `include_in_gl` defaults
to true, so every pre-existing row is unaffected and applying the migration
changes no reported figure. Plaid rows are written `false`, and
`transactionPostings.ts`, `fetchSources.ts`, the bank-ledger grid route and
`autoMapBankLedger` all filter on it. Two further properties say the same thing
independently: the rows carry no `chart_of_accounts_id`, and `affects_pl` is
false. Whether Chase transactions should ever feed the books is a real question
and is **not** answered by this work — the switch exists; nobody has thrown it.

**Plaid's amount sign is the opposite of the intuitive one.** A deposit is
NEGATIVE on a depository account. It is flipped exactly once, in
`transactionAmountToCents`, because `classifySquareSweep` ignores non-positive
lines — get it backwards and every sweep is silently discarded and the drift
reports a confident zero explained, with no error anywhere.

The drift split is null-not-zero: `swept_*` and `unexplained_cents` stay NULL
when the destination account has no lines for the period, so a missing feed can
never look like a finding. Declaring the destination
(`sweepDestinationCoaId`) stays optional — an account without one reconciles
exactly as it did before.

**Still outstanding:** GL Mapping in Finance Settings needs to grow Chase
counterparty mapping and per-source/per-counterparty inclusion toggles. That is
what `include_in_gl` is waiting for.

**Why there is no `transactionPostings` step**, against the pattern every other
composite method follows: 1040's section is `bank`, and for a bank-section
account `normalizeSign.ts` passes the raw cash direction through unchanged, by
design. A Square-to-bank sweep is a POSITIVE row on the bank side, so coded to
1040 it would **increase** the balance it emptied. Making it work would mean
changing `normalizeSign.ts`, which is shared with the P&L. Two steps that are
both right beat three where the third is backwards.

Both steps return null together — unlinked, or no anchor, means the account
reads unsourced rather than as half an answer.

**Anchors are ordinary `manual_entries` balance rows**, not a private store.
That gets the existing operator UI, the unique-per-period constraint and the
month-end close workflow for free. It also means Square is the **first account
to use the close workflow at all** — see §6's note that no manual account was
ever configured, so no close task has ever been created and no alert ever sent.
A `requiresCloseEntry` flag on the method is what makes `closeTasks.ts` raise a
task for a method that is a *calculation* but still needs a human figure.

## 6. Still outstanding, unrelated to integrations

Sync health now reaches the connection store. **BUILT** —
`recordProviderSyncResult` in `connections.ts`; `ramp-expenses-sync` reports
against the Ramp connection and `finance-sync` against the **Square** one. That
second pairing is a correction to what this section used to say: `finance-sync`
touches no Ramp data at all — it syncs Square orders, refunds and invoices, and
what goes stale when it fails is the Square-derived balance on GL 1040.
Recording it against Ramp would have put a true failure on the wrong
integration.

Both record success as well as failure, so a fixed sync clears itself. The
status line is last-writer-wins between the crons and the balance read, which is
bounded rather than ignored: `balance-close` runs at 09:00, after both syncs, so
a genuine balance failure reappears the same morning.

### Make closing a period a human act — BUILT

**Superseded three separate guardrails that were previously listed here.** They
were patches over a model that was wrong underneath, and were built as one
feature instead.

The cron used to freeze a period when every task was done **OR the due date had
passed**. The second condition turns "the deadline went by" into "these books
are final," which are different claims and only one of them is decidable by
software. June 2026 was frozen — marked final — with 6 accounts carrying a
balance and 39 with no source at all. Nobody closed June; 5 July happened.

What shipped, in `lib/finance/balances/periodClose.ts` and
`20260918090000_period_close_is_a_human_act.sql`:

- The cron still snapshots, creates tasks, reconciles and alerts, and **no
  longer freezes**. It reports `readyToClose` instead. `freezePeriod` has
  exactly one caller now, and it is the close action.
- **`balance_period_closes`** is an event log — one row per close or reopen,
  with `actor_id`, `created_at` and a reason. Current state is the newest row,
  so a month closed, reopened and closed again keeps every name rather than the
  last one. `closed_by`/`closed_at` are that row's actor and timestamp.
- **`closePeriod`** recalculates first, then refuses on the two things software
  genuinely knows: an account with an open task (named in the message), or a
  recalculation that did not finish cleanly. No override, and no "close anyway".
  Accounts with no source at all do **not** block — there are always some — and
  are reported as coverage instead: "6 of 12 configured accounts produced a
  balance."
- **`reopenPeriod`** is the symmetric inverse, reason mandatory, and is the only
  caller of `unfreezePeriod`.
- **`snapshotPeriod` refuses a closed period whole**, before reading anything.
  `is_frozen` is per row, so on its own it would let an account configured after
  the close acquire a fresh row inside a month already signed off.
- Writing a manual balance into a closed month is **refused with a sentence**
  rather than saved and ignored, on all three of POST/PATCH/DELETE.
- The nudge banner says when a finished month is still unclosed, from its due
  date onwards.

Settled while building:
- **An unclosed month never hard-locks.** `is_frozen` means one thing only: a
  named person called these books final. If a filed period ever needs a genuine
  cutoff, build that as a separate and differently-named thing.
- **June 2026** — the migration unfreezes every currently-frozen row, because no
  person has ever closed a period and so every one of them was a calendar
  event. It should be closed properly once its accounts have sources.

### Historical backfill — BUILT, and it excludes GL 1100

Only the most recently ended month was ever snapshotted, so months before
2026-06 are blank. Filling one in is just `POST
/api/finance/balance-sources/recompute { periodEnd }` with an older month — the
same operation, no separate route or flag.

The decision this needed: `openInvoiceAr` filters on `status = 'open'`, a
CURRENT status, and `invoices` carries no payment date to reconstruct an
as-at-date one from. **GL 1100 is excluded from backfill** and left with no row,
so it reads as unsourced for that month rather than carrying an understatement
that looks exactly like a real figure. Reconstructing status from payment dates
is a separate piece of work (it needs a `paid_at` source that does not exist
yet), not a flag here.

The mechanism is a declaration, not a special case:
`BalanceProvider.dependsOnCurrentState` marks a provider that can only answer
about today, and a month older than the current close period leaves out the
**whole account** any such step belongs to — dropping only the step would write
the surviving half as a whole balance, which is the GL 2220 partial-sum failure
in a month nobody is watching.

Configuring manual accounts remains the highest-value non-code work available;
GL 1010 is the first account to have it, with an open July task, and is the
first live exercise of the close workflow. Manual entry's setup asks only for
what a rule needs: a responsible person, and optionally how many days after
month end their balance is due.

The work itself lives in **Finance > Transactions > Manual Entries**, which
opens on the outstanding accounts for a period before its ledger, and now ends
on the close itself. Entering a balance there writes the ordinary
`manual_entries` row and the task closes itself via `reconcileCloseTasks`.
Delete that balance and the task goes **back on the list** — reconciliation runs
in both directions, which it did not before; a completed task pointing at a
figure that no longer existed was invisible to the checklist, the banner and the
alert alike. There is deliberately no "mark done" anywhere: a completed task
always has a real balance behind it, or it is a skip with a reason.

Alerts go to each account's responsible person, falling back to `ADMIN_EMAIL`
when nobody is named — and saying in the email that nobody is, since that is a
settings gap the recipient would otherwise have no reason to know about.
`NEXT_PUBLIC_APP_URL` is still blank in the deployment, so the email prints
directions rather than an anchor at `localhost`; setting that variable turns the
link back on with no code change.
