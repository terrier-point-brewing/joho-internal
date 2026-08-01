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
so it is only offered on sensible accounts, and a `describeConnection` so the
Settings row shows connection health.

### c. A connection row
`integration_connections` holds what you are connected to plus any
per-connection secret. Ramp needs no secret (env credentials); Plaid's
`access_token` must live here. **Never** select `credentials` into a response —
`listConnections`/`getConnection` cannot, `getConnectionWithSecrets` is the
deliberate exception.

### d. Daily capture, if the source cannot be asked about the past
Ramp *can* return dated history. Plaid **cannot** — its balance endpoint answers
"right now" and takes no as-of date. For those, write a daily row with
`recordDailyBalance` and have the provider read it with `readDailyBalance`.
Lookup is exact-date only by design; falling back to an earlier capture would
present a stale balance as a month-end figure.

Record the balance under **the date it represents**, not the date you fetched
it. A real-time read taken on the 1st is an intraday balance for the 1st.

### e. Tests
Co-locate `*.test.ts`. The conformance suite in
`methods/definitions.test.ts` will automatically enforce, for your method:
- every step resolves to a registered provider
- every step has a full-sentence description over 40 characters
- no description contains a snake_case identifier, a code call, or a provider key
- the label is sentence case

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

### Square — GL 1040 Square Deposit
**There is no balance endpoint.** Verified against the full v2 spec:
`ListBankAccounts` returns metadata only, and the only `balance` fields anywhere
belong to gift cards and loyalty. The balance must be derived.

Agreed design: **anchor plus movement, re-anchored at each close.**
- An operator-entered balance at a date is the anchor.
- Balance = anchor + payments received − refunds − fees − payouts to bank.
  `GET /v2/payouts` and `/v2/payouts/{id}/payout-entries` give the outbound side
  cleanly (`status`, and a `BANK_ACCOUNT` destination type).
- At month close, prompt the operator to check Square and enter the real figure.
  That figure **becomes the new anchor**, and the drift is logged.

Re-anchoring rather than posting a correcting adjustment is deliberate: drift
cannot compound, each month starts from a verified number, and the derived
calculation only ever has to be right for one month at a time. Expect drift in
the first months — money *in* is the hard half.

Needs `PAYOUTS_READ`. A personal access token likely already has it; verify with
a live call before committing to the design.

## 6. Still outstanding, unrelated to integrations

Four month-end close guardrails, deliberately left out of the scaffolding:

1. Do not freeze a period whose snapshot reported errors — the cron currently
   freezes on schedule regardless.
2. Editing a manual balance for a frozen period silently changes nothing. Needs
   a block or an auto-unfreeze.
3. Unfreeze exists as an endpoint with no UI.
4. No historical backfill — only the most recently ended month is ever
   snapshotted, so months before 2026-06 are blank.

Also note **no account currently uses manual entry**, so zero close tasks have
ever been created and no alert email has ever been sent. The month-end freeze is
presently a calendar event rather than a completeness check. Configuring manual
accounts is the highest-value non-code fix available.
