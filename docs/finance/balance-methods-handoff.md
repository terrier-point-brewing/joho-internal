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
`statementSection === "bank"`), and set `connectionProvider` to your service.

`connectionProvider` is the ONLY thing you implement for connection handling.
From it, generically: the Settings screen shows a picker of that provider's
connections, the chosen id is stored on the source as `config.connectionId`, the
API resolves it, and the health line renders. There is no per-integration
`describeConnection` to write.

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
| Attach one to a GL account | The picker on Settings > Balance Sheet Accounts |
| Read it inside `compute()` | `resolveConnection(supabase, ctx.config)` |
| Store a secret | `writeCredentials()` — server-side only, unreachable by any route |
| Report a read outcome | `recordSyncResult()` |

What you DO build is your provider's **setup flow** — listing Ramp treasury
accounts to choose from, running Plaid Link and exchanging the public token,
capturing Square's opening anchor. That flow ends by calling
`PUT /api/finance/balance-connections`, and writing any secret server-side with
`writeCredentials`. The generic route rejects `credentials` with a 400 rather
than dropping it silently, so a live bank token never reaches a request log.

### d. Daily capture, if the source cannot be asked about the past
Ramp *can* return dated history. Plaid **cannot** — its balance endpoint answers
"right now" and takes no as-of date. For those, write a daily row with
`recordDailyBalance` and have the provider read it with `readDailyBalance`.

Lookup is exact-date only by design; falling back to an earlier capture would
present a stale balance as a month-end figure. Record the balance under **the
date it represents**, not the date you fetched it — a real-time read taken on
the 1st is an intraday balance for the 1st.

**Nothing calls `recordDailyBalance` yet — Plaid owns building the daily cron**
(`app/api/cron/balance-capture/route.ts`, wrapped in `runCronJob` so it lands in
`cron_runs`, registered in `vercel.json`). It was left unbuilt deliberately
rather than guessed at without a real consumer. Square should reuse it if it
needs one; Ramp does not.

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
automatically. If you believe you need to change
`app/settings/finance/balance-sheet-accounts/page.tsx`, that is a signal the
scaffolding is missing something — raise it rather than patching around it, or
three branches will conflict on one file.

**Shared modules Square has already changed** (merged or in review — rebase onto
them rather than re-inventing):
- `methods/registry.ts` — added an optional `requiresCloseEntry` flag to
  `BalanceMethod`. Purely additive; a method that omits it behaves as before.
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
> * A setup flow is a **per-integration** Settings page plus a GET route that
>   lists candidates — `/settings/finance/ramp-connection` and
>   `GET /api/finance/balance-connections/ramp`. The page then calls the shared
>   `PUT /api/finance/balance-connections` itself; no second write path exists.
>   Add a sibling nav entry in `app/settings/nav-config.ts` (one adjacent line).
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

### Plaid — GL 1020 Chase Operating
**Confirm the free tier at signup before building.** Plaid's help centre
describes a Trial plan: free, real production data, up to 10 Production Items,
most OAuth institutions including Chase, for US teams created on or after
2026-04-15. Plaid's pricing page separately says there is no free Production
tier, so the Trial plan is the specific thing to verify. Some institutions need
extra registration for OAuth.

`/accounts/balance/get` returns real-time available and current balance and
forces a fresh pull. Constraints:
- **No historical balances.** Daily capture is mandatory.
- Balance cannot initialise Link on its own — open Link with Transactions, which
  also gets you Chase transaction data.
- Synchronous against the bank; can take 30 seconds. Fine in a cron, not in a
  page load.
- `access_token` is per-connection → `integration_connections.credentials`.

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

**The payouts feed only reports money coming IN.** All 1,755 payouts the API
will return — queried back to 2021, across every location and every status —
carry `destination.type = SQUARE_STORED_BALANCE`. Card sales settle into a
Square-held balance, so a payout here is an **inflow**, not the outbound leg
this section assumed.

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

**Follow-up once Plaid lands GL 1020:** the Chase feed will contain these
inbound transfers, which makes the outflow identifiable. At that point the
sweeps can be subtracted from the drift rows — turning the residual into a true
error term — and the account can move from re-anchoring toward derivation. The
reconciliation table already stores every input needed to do it retroactively.

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

Report Ramp sync health through the connection store. `ramp-expenses-sync` and
`finance-sync` already land in `cron_runs`, but nothing ties that to the Ramp
connection row, so a Settings reader cannot see that a stale balance is caused
by a failing sync. Calling `recordSyncResult` from those crons against the Ramp
connection would close it — additive, no credential moves. Do it after the
integrations land, when a real connection row exists to point at.

### Make closing a period a human act

**Supersedes three separate guardrails that were previously listed here.** They
were patches over a model that is wrong underneath, and should be built as one
feature instead.

Today the cron freezes a period when every task is done **OR the due date has
passed**. The second condition turns "the deadline went by" into "these books
are final," which are different claims and only one of them is decidable by
software. June 2026 is frozen — marked final — with 6 accounts carrying a
balance and 39 with no source at all. Nobody closed June; 5 July happened.

The time-based fallback exists to stop months recomputing forever, which is a
real problem: a late expense coded to July would otherwise change July's balance
in October. But an unclosed month *should* keep recomputing, because it is not
final. What is actually missing is visibility that it is still open.

The shape:

- The cron keeps snapshotting, creating tasks, reconciling and alerting, and
  **stops freezing**.
- A close action records `closed_by` and `closed_at`, refuses (or warns hard)
  while the latest snapshot reported errors, and lists what is outstanding.
- Outstanding tasks are explicitly **skipped with a reason** rather than ignored.
  `balance_close_tasks.status` already has `'skipped'` and a `notes` column,
  both currently unused.
- **Reopen** is the symmetric, attributed inverse. `unfreezePeriod` already
  exists in snapshot.ts and still has no UI.
- Unclosed periods are surfaced loudly rather than silently force-closed.

This absorbs: "do not freeze a period whose snapshot errored" (the close action
refuses, and can say why, because a human is asking); "editing a manual balance
for a frozen period silently changes nothing" (editing a closed period requires
reopening it); and "unfreeze has no UI" (it is the close button's inverse).

Open decisions before building:
- Should an unclosed month ever hard-lock? Recommended no — keep recomputing and
  make it visible. If a filed period needs a genuine cutoff, build that as a
  separate and differently-named thing.
- June 2026 is frozen and materially incomplete. It should be reopened and
  closed properly once accounts have sources.

### Independent of the above

- Report Ramp sync health through the connection store (see the entry above this
  section). Needs Ramp to have landed first.
- No historical backfill — only the most recently ended month is ever
  snapshotted, so months before 2026-06 are blank. **Needs a decision first:**
  `openInvoiceAr` filters on `status = 'open'`, a CURRENT status, so backfilling
  an earlier month counts only invoices still unpaid today and understates
  historical A/R. Either exclude 1100 from backfill, reconstruct status from
  payment dates, or accept and label the understatement.

Also note **no account currently uses manual entry**, so zero close tasks have
ever been created and no alert email has ever been sent. The month-end freeze is
presently a calendar event rather than a completeness check. Configuring manual
accounts is the highest-value non-code fix available.
