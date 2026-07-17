# Finance Tab — UI Standard Conformance

**Goal:** Bring `app/finance/**` fully onto `docs/UI_STANDARD.md` — eliminate the 119 arbitrary
sub-`xs` type sizes, stop inline data-category colors, replace hand-rolled segmented/toggle
controls, and DRY the Settings section chrome. This is consolidation onto existing dominant
patterns, **not** a redesign — no visual behavior change beyond the deliberate `text-2xs` tier
and the Settings title-semantics change below.

**Execution Budget:** Mode = write-a-plan → execute inline for Phases 0–5 (style conformance, ~12
files); Phases 6.5/6.6 (CoA delete route, ledger pagination) are behavior changes best done as a
follow-up increment. ~8 locality groups. Spawn cap = 8 + 2 = 10. Token target ~200k. STOP and report
before exceeding. Recommend shipping Phases 0–5 + the mechanical UX fixes (6.1–6.4) first, then
6.5/6.6 as a second PR.

## Decisions (ratified)
- **Sub-`xs` type:** add ONE sanctioned `text-2xs` (10px) utility to `@theme`, document it in
  UI_STANDARD.md §1 as the dense-table caption tier, migrate all `text-[10px]` → `text-2xs`.
  Stray `text-[9px]`/`text-[11px]` collapse into `text-2xs` (dense) or `text-xs` (already-caption).
- **Canonical page order is title-first** (verified against production + every other finance area):
  `<SubNav mobile>` (hidden on desktop) → `<PageHeader title>` → `<SubNav section>` → body. Settings
  is already title-first; keep it that way. No reordering.
- **Settings chrome + title:** hoist the shell + `FinanceNav` + a **static `<PageHeader title="Settings">`**
  + `SettingsNav` into `app/finance/settings/layout.tsx`, mirroring `transactions/layout.tsx` exactly
  (which titles by area name, as do Financials/Payroll/Tax). The sub-tab identifies the view; each
  page's per-tab description + action buttons (e.g. "342 accounts · last uploaded…", Upload CSV,
  Sync Catalog) move into a control bar at the top of that page's body. This makes Settings title
  like its siblings instead of being the one section that puts the sub-tab name in the H1.

## File map
- `app/globals.css` — add `.text-2xs` (or `@theme --text-2xs`) 10px/1.1 tier
- `docs/UI_STANDARD.md` — §1 table: document `text-2xs` as the dense-caption exception
- `app/finance/lib/categoryColors.ts` — add `DEPOSIT_BS_TOGGLE_CLS` / `DEPOSIT_SURFACE_CLS`
  constants for the violet BS-recognition toggle + panel (currently inlined)
- `app/finance/settings/layout.tsx` — NEW section layout
- `app/finance/settings/*/page.tsx` (8 leaves) — drop repeated shell/FinanceNav/SettingsNav; type + color migration
- `app/finance/transactions/{invoices,orders,expenses,bank-ledger}/page.tsx` + `transactions/components/*` — type + color migration
- `app/finance/settings/payroll/page.tsx` — remove local `inputCls`; tokenize checkbox accent
- `app/finance/settings/chart-of-accounts/page.tsx` — view toggle → `TabBar`; checkbox accent
- `app/finance/financials/page.tsx` — `KpiTile` responsive size

## Tasks

| # | Group | Task | Files | Model |
|---|-------|------|-------|-------|
| 0.1 | Foundation | Add `.text-2xs` utility (10px, line-height 1.1) to globals.css. Document in UI_STANDARD.md §1 as the sole sanctioned sub-`xs` tier for dense table meta/pills. | `globals.css`, `UI_STANDARD.md` | Sonnet |
| 0.2 | Foundation | Add `DEPOSIT_BS_TOGGLE_CLS` (active/inactive violet) + `DEPOSIT_SURFACE_CLS` panel classes to `categoryColors.ts`, alongside existing `DEPOSIT_CATEGORY_CLS`. | `categoryColors.ts` | Haiku |
| 1.1 | Settings | Create `settings/layout.tsx` mirroring `transactions/layout.tsx`: `flex flex-col h-full bg-canvas text-primary` shell + `<FinanceNav mobile/>` + static `<PageHeader title="Settings"/>` + `<SettingsNav/>`. Strip that chrome (shell, FinanceNav, per-page PageHeader, SettingsNav) from all 8 settings leaves; each page renders only a control bar (its former description + action buttons) + body. Verify sticky/scroll unaffected. | `settings/layout.tsx` + 8 `settings/*/page.tsx` | Sonnet |
| 2.1 | Settings | Migrate all `text-[10px]/[9px]/[11px]` → `text-2xs`/`text-xs` in settings pages. Replace inline violet (account-mapping:171,215,217) with the Task 0.2 constants. Normalize the split/deposit toggles to use the shared classes. | `settings/account-mapping`, `settings/chart-of-accounts`, others | Haiku |
| 2.2 | Settings | chart-of-accounts: replace hand-rolled Statement/By-Type segmented toggle (887–896) with `<TabBar>`; tokenize `accent-amber-500` checkboxes; remove local `inputCls`/`labelCls` in `settings/payroll` (pass `.inp` directly). | `settings/chart-of-accounts`, `settings/payroll` | Sonnet |
| 3.1 | Transactions | Migrate all `text-[10px]/[11px]` → `text-2xs` across transactions pages + components. Replace inline violet BS pill (invoices:335) with Task 0.2 constant. | `transactions/{invoices,orders,expenses,bank-ledger}`, `transactions/components/{MappingStatusPill,PayrollSplitCell,LedgerTable}` | Haiku |
| 4.1 | Polish | `KpiTile` value → `text-base sm:text-xl` (§1). Optional: swap native `confirm()` in `tax/ScheduleList` deactivate for `<Modal>` confirmation. | `financials/page.tsx`, `tax/ScheduleList.tsx` | Sonnet |
| 5.1 | Verify | `npm run verify` green; grep confirms 0 `text-[Npx]` and 0 inline violet/teal in `app/finance/**`; browser spot-check account-mapping tree, chart-of-accounts, invoices ledger, Financials at desktop + mobile widths. | — | Sonnet |

## Acceptance criteria
- `grep -rE 'text-\[[0-9]' app/finance` → **0** matches.
- `grep -rE '(bg|text|border)-(violet|teal|purple)-[0-9]' app/finance --include='*.tsx'` outside
  `categoryColors.ts` → **0** matches.
- No `flex flex-col h-full` + `<FinanceNav mobile/>` + `<SettingsNav/>` triple repeated in any
  settings leaf (all inherited from `settings/layout.tsx`).
- No local `inputCls`/`selectCls`; no raw `accent-amber-500`.
- `npm run verify` passes; no visual regression in the 4 spot-checked pages (light + dense rows
  still legible at 10px via `text-2xs`).

## Interaction / UX findings (beyond style conformance)

Ranked by user impact. These are confusion / data-loss / missing-affordance issues, not token drift.

**H1 — Payroll Settings: two Save buttons for one config object + one silent save.**
[settings/payroll/page.tsx](../../../app/finance/settings/payroll/page.tsx) splits a *single* `payroll_config`
row across **"Save Pay Schedule"** (§Pay Schedule) and **"Save Rates"** (§Rate Configuration). Editing
rates then clicking the first/more-prominent "Save Pay Schedule" persists the schedule but the user
assumes everything saved. Worse, `saveRates` has **no success message** (`saveSchedule` shows "Saved.")
— a rate edit gives zero confirmation. → Consolidate to one "Save Settings" action (or clearly scope
each section + give `saveRates` the same success toast + disable-until-dirty on both).

**H2 — Destructive bulk action with a tiny label and no confirm.** In Account Mapping's `BulkMapper`,
the second button is literally **"All"** ([account-mapping/page.tsx:291](../../../app/finance/settings/account-mapping/page.tsx:291))
= `overwrite: true`, which **overwrites every existing GL mapping** in that category/parent with no
confirmation, sitting flush against the safe "Fill N" button. High-consequence, high-misclick. → Rename
to "Overwrite all (N)", require a confirm `<Modal>`, and visually separate it from "Fill".

**H3 — Silent instant destructive toggles.** Employee Active↔Inactive
([settings/payroll/page.tsx:487](../../../app/finance/settings/payroll/page.tsx:487)) deactivates on a
single click, no confirm; the button turns red only on hover with no label change (ambiguous intent).
Counterparty **Routing** `<select>` flips single-account↔payroll-split instantly and swaps the whole GL
column. → Add a confirm for deactivation; consider a clearer toggle affordance.

**H4 — Mixed save paradigms with no affordance cue.** Three coexisting models, no signal telling the
user which they're in: (a) **auto-save on change** — Orders / Invoices / Bank Ledger / Account Mapping /
Counterparty (every dropdown PATCHes; feedback is a ~150 ms "…" pulse that vanishes); (b) **buffered
form Save** — Chart of Accounts edit, Payroll, Add Employee; (c) **multi-step commit** — CoA CSV
(idle→preview→done). Account Mapping mixes (a) *and* explicit bulk buttons on one screen. → Adopt one
consistent inline auto-save indicator (transient "Saved ✓" replacing "…"), and document the pattern so
auto-save surfaces read distinctly from buffered-Save forms.

**H5 — Literal "pin" text instead of an icon/badge.**
[PayrollSplitCell.tsx:172](../../../app/finance/transactions/expenses/PayrollSplitCell.tsx:172) renders
the word `pin` (`<span…>pin</span>`) to mark a manually-overridden split line — almost certainly meant
to be a 📌 / `<Badge>`. Reads as a typo. → Replace with an icon or `<Badge tone="info">manual</Badge>`.

**H6 — Missing expected single-row Delete.** Chart of Accounts can add + edit accounts but the only way
to **delete one** is to re-upload a CSV that omits it (delete-by-omission in the preview flow). Users
will look for a per-row Delete in the edit panel. → Add a Delete action (with confirm) to `EditPanel`,
or document why deletion is CSV-only.

**H7 — Native `confirm()`/`alert()` instead of `<Modal>`.** [tax/ScheduleList.tsx:52](../../../app/finance/tax/ScheduleList.tsx:52)
(deactivate), [PayrollSplitCell.tsx:104](../../../app/finance/transactions/expenses/PayrollSplitCell.tsx:104)
(overwrite manual split), `tax/[taskId]/FileUploader.tsx`, `transactions/expenses/page.tsx`. Unstyled
browser chrome, not theme-aware, not testable. → Route through the shared `<Modal>`/`<ModalActions>`.

**H8 — Sibling ledger tabs behave differently.** Orders paginates (50/page, Prev/Next) + uses local
`useState`+manual fetch + optimistic patch; Invoices loads all + react-query + refetch-after-save. Same
"ledger" mental model, two behaviors (and only Orders can hit page-2). → Align on one data/pagination
pattern across Orders / Invoices / Bank Ledger.

**H9 — One concept, three visual treatments on one screen.** Account Mapping renders "split" as a
`▾ split` text-caret toggle (row), a `✦ split` starred button (`BulkSourceMapper`), and a
`SPLIT_CATEGORY_CLS` pill (category header) — plus a `BulkSourceMapper` panel that's
`absolute top-full` floated over the row (fragile overlap). → Unify the split/deposit affordance into one
toggle/badge vocabulary; anchor the bulk panel in flow, not absolutely.

### Suggested phase (add to task table)

| # | Group | Task | Files | Model |
|---|-------|------|-------|-------|
| 6.1 | Payroll UX | H1: unify payroll config save (one "Save Settings" or scope both + add `saveRates` feedback + dirty-gating). H3: confirm on employee deactivate. | `settings/payroll/page.tsx` | Sonnet |
| 6.2 | Mapping UX | H2: "Overwrite all (N)" + confirm `<Modal>` + visual separation. H9: unify split/deposit affordance; de-float `BulkSourceMapper`. | `settings/account-mapping/page.tsx` | Sonnet |
| 6.3 | Quick fixes | H5: replace literal "pin". H7: swap native `confirm()`/`alert()` for `<Modal>` (4 sites). | `PayrollSplitCell.tsx`, `tax/ScheduleList.tsx`, `tax/[taskId]/FileUploader.tsx`, `transactions/expenses/page.tsx` | Sonnet |
| 6.4 | Save-model | H4 (**decided: keep auto-save + add indicator**): shared inline auto-save indicator (transient "Saved ✓" replacing the "…" pulse); apply across Orders/Invoices/Bank Ledger/Account Mapping/Counterparty. No switch to buffered Save. | new `transactions/components/SaveHint.tsx` + call sites | Sonnet |
| 6.5 | CoA delete | H6 (**decided: add per-row Delete + confirm**): Delete action in `EditPanel` behind a confirm `<Modal>`; before deleting, check whether the account is referenced by any GL mapping (account-mappings / invoice / expense / counterparty) and **block or warn** rather than orphaning. Needs a `GET …/chart-of-accounts/:id/references` (or count) check + `DELETE` route if absent. | `settings/chart-of-accounts/page.tsx`, API route | Opus (touches referential integrity) |
| 6.6 | Ledger paging | H8 (**decided: paginate all three**): give Invoices + Bank Ledger the same 50/page server pagination as Orders; align their data layer (react-query) and add Prev/Next. Confirm client-side filter/sort still composes with server paging. | `transactions/{invoices,bank-ledger}/page.tsx`, LedgerTable | Opus (data-layer change) |

## Decisions (resolved)
- **H4 save model:** keep auto-save on the ledgers; add a shared transient "Saved ✓" indicator. No
  buffered-Save refactor.
- **H6 CoA delete:** add per-row Delete + confirm `<Modal>`; block/warn when the account is still
  referenced by existing mappings (no silent orphaning).
- **H8 ledger paging:** paginate all three ledgers on the Orders pattern (50/page, react-query).

## Out of scope
- Sales/Statements subtabs (already redirects into Financials).
- The `MeasureChips` exclusive group in Financials (documented `FilterChips` exception).
- Any data/logic change — this is styling + structure only.
