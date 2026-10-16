# UI Information-Overload Review — 2026-10-16

Scope: Taproom, Production, Finance, Settings. Lens: explanatory "tiny text" that exists because the UI is not intuitive enough. Priority: anything a non-admin (viewer / brewer / manager) can reach.

Findings only; no code was changed. Every quoted line was read in source on branch `claude/ui-information-overload-review-22513e`.

---

## 1. Headline

The app has a consistent habit: **it explains the mechanism when the operator only needs the procedure or the consequence.** Roughly 150 explanatory sentences were catalogued. About a third should simply go, a third should become labels / units / defaults / tooltips, and a third are genuine consequences of irreversible actions and should stay (but shorter).

The overload is not evenly spread. It clusters in five places:

| # | Hotspot | Who sees it | Why it is the worst |
|---|---|---|---|
| 1 | Production money layer: Export Bay ship modal, Partner Ledger, Batch Log allocation plan, Invoice preview, deposit coverage lines | **brewer** (operate) | Internal model (commitment → allocation → share → deposit → coverage → back-charge) is rendered raw, in its own vocabulary, in 10–11 px text |
| 2 | Taproom Draft Stats swap modal + Configure Taps, and the Square drift view | **viewer, brewer, manager** | Square's internal mechanics (restock rings, recount targets, committed units) explained to bartenders; drift view is ungated |
| 3 | Settings > Production (deposits / export / partner portal) | **brewer** (manage) | Five-line essays under single number boxes |
| 4 | Finance > Bank Ledger / Expenses / Manual Entries footers, per-row flow sentences | admin | Highest sheer line count: 50 rows × 1 sentence + 3 footer paragraphs |
| 5 | Settings > Finance GL Mapping footers, Balance Sheet drawer, all four Backfill screens | admin | 80–200 word rationale essays written for a developer |

Two shared components actively *cause* the problem: `MappingFrame.footer` (required prose prop under every mapping table) and `BackfillShell` (`what` + `impacts` + `danger` + permanent "Irreversible" banner). Fix those two and a quarter of the admin text disappears by construction.

---

## 2. House rules this review recommends adopting

These are the patterns that already work well in the app and should become the standard. Each one removes a class of explanatory text.

1. **Units and consequences go in the label, not under it.** "Due in __ days after draft", "Keg size: 1/2 BBL · 1,984 oz", "Total (fl oz)". Kills most "what does this number mean" sentences.
2. **Defaults instead of instructions.** Freight = 0, convert target = new batch, tier = Target. Kills "enter 0 if…" and "pick X first" copy.
3. **Don't describe a constraint the control already enforces.** Liability-only dropdowns, destination lists that are already filtered, steps that can't be toggled separately.
4. **Consent lives in the checkbox label.** "Ship before the deposit is paid" needs no paragraph above it.
5. **Mechanism goes behind an ⓘ / "Why?" / collapsed `<details>`.** Anything citing Square internals, NC DOR, TTB, excise, back-charge rules, cron timing. The existing `DraftStatsHelp` modal (button → when → steps) and the collapsed `<details>` in Configure Taps are the right shapes. `DataQualityPanel` (one indicator, detail on demand) is the right shape for status.
6. **Status is a chip, not a sentence.** Deposit: Paid / Due / Partly paid / Waived. P&L: badge, not faint "yes / —".
7. **Warnings appear at the confirm step, not permanently.** Backfill, period close.
8. **Say it once, app-wide.** The deposit back-charge rule is explained in ≥4 places; "balances stop recomputing" in 4; manual-entry Kind semantics in 2; the re-home block is copy-pasted 3 times.
9. **Hide what the role can't do** instead of explaining who can ("ask an admin", "Needs tap setup by an admin").
10. **Rename internal vocabulary where a non-admin reads it.** See §7.

---

## 3. Taproom (all roles)

**Verdict.** Sales Pulse, Events, Achievement, Target Setting and the on-hand Inventory grid are lean. Overload sits in Draft Stats (cards, swap modal, Configure Taps) and the Square drift sub-view.

### Draft Stats — tap cards (`app/taproom/components/DraftStatsTab.tsx`)
- "Draft tap status, sell-through rates, and shrinkage trends from Square inventory." (514) — **DROP**; the three sub-tab names say it.
- Booking-gap footer "Ring Draft Restock in Square each time… Assigning a beer here does not move inventory." (613) — **SHORTEN** to one line.
- Four numbers per card (fl oz avail / BBL on hand / oz per day / days left) × up to 32 cards (895–920) — **REPLACE-WITH-UI**: show days left + oz/day; fl oz and BBL are the same quantity twice; put them on expand/hover.
- Sub-view subtitles "fl oz poured per beer…", "fl oz unaccounted for…" (548, 565) — **SHORTEN**: unit in the column header, keep "lower is better" only.
- Column `title=` tooltips (120–126) — **KEEP**, right pattern.

### Draft Stats — swap / set beer modal (978–1110) — manager+
- "This queues the change now and books it when a bartender rings Draft Restock Tap N. Until then…" (982) — **SHORTEN** to "Takes effect when Draft Restock Tap N is rung."
- "Full-keg volume — recount target" read-only field (1042) — **REPLACE-WITH-UI**: rename "Keg size", fold volume into the keg option label.
- Three stacked banners (same-beer, write-off, rename-in-Square) (1053–1102) — keep write-off amount and rename reminder; **DROP** the "nothing is written off" banner (absence of a consequence).
- "— stops brew suggestions. Tapping it again un-retires it automatically." (1088) — **SHORTEN** to "Also retire {beer}".
- Button "Queue swap / Queue beer / Queue keg size" (1110) — **REPLACE**: "Save". "Queue" is the mechanism in the verb.

### Draft Stats — Configure Taps (620–690, 760–845) — admin only
- "Tap assignment slots will update below." (629) — **DROP**.
- "Draft Restock line item → tap mapping" + 4-line paragraph (637–643) — **SHORTEN** to "Pick which Square Draft Restock line belongs to each tap."
- Collapsed `<details>` "How to set up the Square line item" (647–656) — **KEEP**; this is the pattern.
- Per-card labels "Square 'Draft Restock' line", "Keg to drain on swap", "Full-keg volume — recount target" (787, 810, 831) — rename "Restock line", "Keg size", drop the volume row.

### Draft Stats Help (`DraftStatsHelp.tsx`) — **KEEP and standardise on it.** Make it the destination for the mechanism prose stripped above. Hide the "Configure Taps / admin only" section for non-admins.

### Sales Pulse (`SalesPulseTab.tsx`)
- "'est.' — Square sent this refund without per-line detail, so it was split…" (228) — **SHORTEN** to "est. = refund split across the order."
- Legend "Included in taproom net sales / Excluded" (524–533) — **DROP**; rows already dim and show "excl."
- KPI tiles and chart metric chips duplicate each other — make the tile the selector.

### Achievement (`AchievementTab.tsx`)
- "How to read the two signals" box, five lines with formulas (548–556) — **REPLACE-WITH-UI**: ⓘ on the two tile labels; the pace bar already makes "on pace" self-evident.
- "low confidence, 23% elapsed" (439–508) — **SHORTEN** to "early estimate".
- Six controls in two rows — default Compare-vs to Target; collapse tier chips into a select.

### Target Setting — lean, **KEEP** as is.

### Events (`EventsTab.tsx`)
- Subtitle (280) — **SHORTEN** or move to empty state.
- Column "Variation" (173) — rename "Item"; "variation" is Square's word.

### Inventory — on hand (`InventoryTab.tsx`)
- 10 px bbl sub-line under every quantity cell (95, 123) — **REPLACE-WITH-UI**: units in header, bbl in footer total only. This is exactly the "tiny text" the owner means.

### Inventory — Square drift (`SquareDriftPanel.tsx`) — **ungated, every viewer sees it**
- Header "Square measured against cold storage. Cold storage is the app's record; neither side is being corrected…" (102–104) — **SHORTEN** to "Square vs cold storage (nothing changes here)."
- Held-back box, three lines on committed-vs-paid invoices (139–157) — **SHORTEN** to "Not pushed yet — Square holds these against an open invoice."; mechanism → tooltip.
- "Committed" column title, three sentences (239) — **SHORTEN**.
- Dead-link banner "These are not zero stock — they are unmeasurable…" (170) — **SHORTEN** to "Mapping points at a deleted Square item — re-point it."
- Cans note on loose-can derivation (291) — **DROP**; the breakdown column shows it.
- **Whole view: gate to manager+ or move under Settings > Catalog.** It is a reconciliation tool living under a viewer-visible tab.

---

## 4. Production (brewer = primary persona, operate on nearly everything)

**Verdict.** Floorplan, Batch Log list, Recipes, Ingredients/Packaging and the Shipments list are fairly clean. The overload is the money-and-entitlement layer: Export Bay ship modal, Partner Ledger, Batch Log allocation plan, TransferModal convert mode, Invoice preview, partner-request approval, ConversionAllocationPanel. ~60 explanatory sentences; nearly all brewer-visible.

### Export Bay (`app/production/components/ExportBayTab.tsx`)
- "Needs a home" block in the ship modal: "It needs a home on #… The booking rises by … and the share comes from:" + radio options with inline disabled reasons (1634–1660) — **REPLACE-WITH-UI**: a separate step, "This ships X bbl more than booked — where does it come from?", with plain options (Unassigned beer / Taproom's share / Partner X's share) and disabled reasons as tooltips.
- Same block for new bookings (1596–1620), and again in `PartnerLedgerTab.tsx` 86–126 — **one shared component**, one copy of "A commitment will be created and flagged for review."
- "This shipment credits a contract allocation whose ingredient deposit has not been paid. Ship anyway and…" + checkbox (1673–1676) — **SHORTEN** to the checkbox plus "Deposit unpaid — it will be added to this export invoice."
- Ad-hoc channel note (1796) — **DROP**; the next step shows it.
- Allocation rows: "booked / plan", "≈ 2.31 so far", "· owed", "· over" in 10 px plus `DepositCoverageLine` ("Base ✓ paid on parent #12", "Additions — $40.00 collected on export invoices, more due on the next shipment", "Base ⚠ parent deposit refunded — base is chargeable here") (`DepositCoverageLine.tsx` 22–60) — **REPLACE-WITH-UI**: one status chip per allocation (Deposit paid / Deposit due / Partly collected), base/additions breakdown on hover or expand.
- Write-off modal "Forgiving X BBL (Y% of the entitlement). No refund is issued…" (1186–1190) — **SHORTEN** to "Marks the remaining X BBL as delivered. No refund." Over-tolerance warning **KEEP**.
- Sync Taproom modal intro (1275–1279) — **SHORTEN** to "Books Square taproom sales against cold storage. Safe to re-run." Diagnostics **KEEP**, under a "Needs setup" heading.
- Phantom-stock modal intros (430–445) — **KEEP**; genuinely non-obvious. Button "⚑ 3 booked without cold-storage stock" → "3 sales with no stock to deduct".
- Header button `title=` tooltips (727–742) — **KEEP**.

### Partner Ledger (`PartnerLedgerTab.tsx`)
- Share formula line "12.50% of #41 — 3.00 bbl booked ÷ 24.00 bbl planned · Packaged 20.1 + 3.9 expected from tank = 24.0 → capped at booked 3.00 = owed 3.00 bbl · shipped · remaining · written off" (340–362) — **REPLACE-WITH-UI**: show "Owed 3.00 bbl" with an ⓘ popover holding the derivation. **Single densest line in the module.**
- Deposit status labels "paid · amount not recorded", "written off, never paid", "collecting per shipment", "invoiced, awaiting payment" (307–330) — **SHORTEN** to Paid / Due / Partly paid / Waived; detail on hover.
- Stat strip "X bbl shipped, not invoiced | $Y invoiced, unpaid | Z bbl still to deliver" (575–581) — **KEEP** as three tiles.

### Batch Log (`BatchLogTab.tsx`)
- Allocation plan warnings (757, 770–778) — **KEEP**; rename "Allocation plan" → "Who gets this batch", "unallocated" → "unassigned".
- Locked-percentage tooltip (825) — **KEEP**.
- Volume breakdown "available of 20.00 total ⚠ unbalanced · 1.2 converted · 3.0 exported · 0.8 shrinkage" (1510–1530) — **REPLACE-WITH-UI**: stacked bar + legend; "shrinkage" → "loss".
- Empty state second sentence "Click '+ Add allocation' to start." — **DROP**.
- Tank reassign explainer (1653) — admin only, **KEEP**.

### Transfer modal (`TransferModal.tsx`)
- Allowed-destinations box "Fermenter → Brite/Fermenter (incl. staying put…), Kegging, or Canning" (598–603) — **DROP**; the dropdown already filters.
- Convert-mode intro paragraph (591–594) — **REPLACE-WITH-UI**: segmented control "Into an existing batch / As a new batch".
- "Capacity: 10.00 bbl — transfer will be rejected if it exceeds this." (695) — show capacity beside the input, red on overflow.
- Deviation-from-plan warning (698–703) — **KEEP**, shorten to "Planned for FV2 — proceeding cancels that booking."
- Can material-loss line (826–830) — **KEEP**, one line; real surprise.
- `ConversionAllocationPanel`: "Estimates on booked volume — final entitlements settle on packaged volume." (210) — **DROP**; keep "Set a row to 0…" and "unpaid deposit invoice will be revised" as one line. Replace `alert()` failure paths (458–464) with a dialog.
- `ConversionTargetFields` option-group "Other batches (additions won't be costed)" (149, 172) — lock icon + tooltip; "costed" is finance-speak.

### Invoice preview (`InvoicePreviewModal.tsx`)
- Per-batch deposit-reason sentences (32–40) — **SHORTEN** to status tags (Collected per shipment / Covered by deposit / Charged here), long form on hover.
- Converted-beer checkbox tree intro (610–616) — **KEEP** first sentence; show the exclusion cascade by greying descendants so the second sentence goes.
- Channel-mismatch / NC DOR note (480–487) — **KEEP but collapse** under "Why does this matter?"
- "Square calculates the exact discounted total…" (907) — **DROP**; "Manual invoices are recorded as Unpaid…" (913) — **SHORTEN**.

### Shipments / Export Invoices / Credit & Cancel modals
- Row badge `title=` tooltips (ShipmentsTab 765–789) — **KEEP**; badge text "phantom" → "No stock".
- CreditInvoiceModal reason options, CancelInvoiceModal consequence line — **KEEP**; short and consequential.
- ExportInvoicesTab uses `window.prompt` / `confirm` (170, 187) — replace with ConfirmDialog (as #667 did elsewhere).

### Intake (`app/production/intake/*`)
- PartnerRequestsTab approval explainer, four 30-word variants (250–256) — **SHORTEN** to one line; the back-charge rule is already explained in three other places.
- CommitmentsTab "(Deposit invoices are only used for Contract Brewing)" (152) — **DROP**, show "—". "Not locked yet — it locks when the deposit is paid." (371) — **KEEP**.
- Tab description second sentence "A deal with no batch yet shows a Schedule button." (481) — **DROP**.
- PlanTab "short until then; a new batch would not arrive sooner" (61) — **KEEP**; model plain language.

### Recipes / Ingredients / Packaging
- Identical landed-cost callouts (IngredientsTab 882, PackagingTab 401) — **REPLACE-WITH-UI**: rename field "Landed cost per unit" with ⓘ; delete both boxes.
- "Enter 0 if no freight charge" (982, 505) — **DROP**; default 0.
- Case-pack hint "set the lid/label/partner above first so the matching siblings show up" — reorder fields so the dependency is already satisfied; hint shrinks to five words.
- RecipesTab 1242 "When a new batch is created… copied into the batch's activity log." — **SHORTEN** to "Copied into each new batch's log."
- Tab subtitles ("Define beer recipes with ingredient bills and brew steps", "Reusable step sequences…") — **DROP**.

### Brewing floorplan / Gantt
- Floorplan tiles render text at 7–9 px (`BrewStatusTab.tsx` 857–1150) — **REPLACE-WITH-UI**: ≥11 px, move "upcoming" lists to click/hover. 7 px is unreadable on the floor.
- "Timeline view is desktop-only" (GanttTab 300) — **KEEP**.

---

## 5. Finance (admin today; custom roles can be granted)

**Verdict.** Better than its reputation. The three statements, Period Close index, Duplicates, and the Tax hub are clean. Overload concentrates in Bank Ledger / Expenses / Manual Entries footers and per-row sentences, Period Close status prose, Payroll period view, long hover-only tooltips carrying load-bearing meaning, and page subtitles written as design notes. Audience is finance-literate, so most text should be **collapsed, not deleted**.

### Financials (`FinancialsClient.tsx`, `FinancialsTable.tsx`, `SpendWatchTab.tsx`, `DataQualityPanel.tsx`)
- Subtitle "Consolidated P&L, Balance Sheet, and Cash Flow — persisted, CoA-mapped data" (247) — **SHORTEN** to "Monthly statements" or drop.
- KPI tiles rendering "n/a" on statements that don't carry them (117–121) — hide instead.
- Filter bar: Channel / Section / Quality / GL# / Measure (286–316) — move GL# and Measure into a "View" menu.
- Hand-entered balance `title` (FinancialsTable 97) — **KEEP**, shorten to "Entered by hand — overrides the feed".
- DataQualityPanel — **KEEP; this is the model to copy.**
- Spend Watch conditional paragraphs (103–110) — fold cash-basis caveat into ⓘ on the Accrual/Cash toggle; "month in progress" becomes a "partial" badge on the month chip; threshold rule into the tile tooltip.

### Period Close (`layout.tsx`, `PeriodClosePanel.tsx`, `ClosePeriodFooter.tsx`, `CloseTasksBanner.tsx`)
- Subtitle "The month-end checklist and the human act of closing a period — a closed month's balances stop recomputing" (layout 19) — **SHORTEN** to "Month-end checklist".
- Status line "…is still open, so its balances keep recomputing. Nothing is final until somebody says so." (Footer 139–149) — **SHORTEN**: badge + "Closed by X on date". Say "stops recomputing" once, in the Close modal (currently 4×).
- Coverage sentence + `<details>` (Footer 191–215) — **KEEP-BUT-RESTRUCTURE** as "Coverage 24/28" stat with names behind the existing disclosure; drop "usually because…".
- Preview "Closing now would land … at $X — still unaccounted for" (Footer 218–250) — **KEEP**; label it "Balancing difference" to match the index column. Load-bearing.
- Duplicates gate banner (Panel 262–270) — **KEEP**.
- Per-task row "The feed computes $X (as of date) — save to confirm it, or correct it first. Last entered $Y as at date." (Panel 152–164) — **REPLACE-WITH-UI**: pre-fill the input, chips "Suggested · date" and "Last $Y · date".
- Skip modal intro (Panel 406–410) — **SHORTEN** to "Records that X had no balance this month. Reason required."
- Close modal placeholder "e.g. closes at +$822.07 of month-boundary timing: wages paid Jun 2, card statement, untracked inventory" (Footer 318–327) — **SHORTEN**.
- "put back on the list", "somebody whose login has since been removed" — **SHORTEN** to "Reopen", "(removed user)".
- CloseTasksBanner on Financials (46–60) — one line: "September close: 3 balances outstanding → Period Close".

### Transactions · Bank Ledger (`bank-ledger/page.tsx`)
- Per-row `def.effect` sentence under every Flow select (172; nine variants from `lib/finance/flowTypes.ts`) — **REPLACE-WITH-UI**: effect into the option label or ⓘ on the select; make the P&L column a real badge instead of faint "yes / —". **Highest-volume noise in Finance.**
- Footer paragraph on how flows work and where to set a standing rule (254) — **KEEP-BUT-COLLAPSE** behind "How flows work"; surface "Set a standing rule" as a link on `auto` rows.
- "An account is still set on this row. Pick a flow above that uses one, or it will be cleared." (121) — **DROP**; just clear it.
- Two refresh buttons ("Refresh Ramp", "Refresh bank feed") — one "Refresh".

### Transactions · Manual Entries
- Footer paragraph defining Transaction vs Balance (~430) — **DROP**; the Kind chips already say it.
- Account-effect warnings (`lib/finance/manualEntryEffect.ts` 61–83) — one line + action chip; Settings path becomes a link.
- "Saves as <date> — balances only save on a month end." (~170) — **REPLACE-WITH-UI**: month picker.
- "liability/equity account — often stored negative" — drop or sign toggle.

### Transactions · Duplicates — **KEEP** the modal and its per-answer effect lines; empty state → "No possible duplicates found."

### Transactions · Orders / Invoices / Expenses
- Expenses footer paragraph (662–667) — **DROP**.
- `pin` / `rule` micro-tags with long titles (217–220) — badges "Pinned" / "Rule", short tooltip.
- Exclude-as-duplicate confirmation (377) — **KEEP**.
- Orders "Orders load 50 at a time, so this GL filter applies to the current page…" (~480) — **REPLACE-WITH-UI**: server-side filter; the caveat is an apology for the UI.
- SyncPanel (104–139): one Sync button, status as dot + tooltip, "Run scheduled sync" into overflow.

### Tax
- Hub, TaskList — **KEEP**; cleanest screens in the module.
- ScheduleEditor (206–208, 230, 234, 105, 333, 386) — ≤1 line per field; Settings cross-reference becomes a link; "Lead days" → "Open task N days before due".
- Worksheet shell Filing Identity card — default collapsed.
- Party worksheets mirroring government form line numbers — **KEEP**; the jargon is the form's.

### Payroll (`PeriodsTable.tsx`, `PayrollPeriodView`, `ShiftTimeline`, `AdjustmentsPanel`, `GustoUploadPanel`)
- Subtitle — **SHORTEN** to "Pay periods".
- PeriodsTable 12 columns with meaning only in `title` (60–170) — merge the two check columns into one "Reconciled" with a tooltip listing what's missing; "Taproom vs app" → "Shifts vs Gusto".
- Cash-tips basis toggle + trailing explanations (230–243) — tooltip on the chips; default Actuals.
- Three stacked context lines before the table (246–290) — "vs prior: +12% wages" chip; drop "pass-through, not our cost".
- ShiftTimeline override-mode banner (211–230) — one-line hint inside the edit affordance; variance banners **KEEP**, ≤1 sentence.
- AdjustmentsPanel intro (130–132) — into the Scope column tooltip.
- GustoUploadPanel actionable banners — **KEEP**.

### OK to keep for a finance-literate admin
DataQualityPanel, Duplicates modal, tax worksheet form-line labels, Expenses exclude confirmation, close/reopen reason requirements, variance banners, hover tooltips on hand-entered balances, stat bars on every transactions tab.

---

## 6. Settings

**Verdict.** Brewer-visible screens (Production, Catalog, User) are mostly fine with two clear offenders: the Expected Packaging Yield and Taproom Reserve paragraphs. The admin-only Finance group is where the real overload lives, and two shared components encourage it.

### Production > Deposit Settings (`DepositSettingsPanel.tsx`) — brewer
- "Default Square catalog item for deposit invoices, with optional per-partner overrides." (47) — **DROP**.
- Net terms paragraph — **SHORTEN** to label "Due in __ days after draft".
- Expected Packaging Yield, five lines (160–166): "…a higher number charges less, which is recoverable, while a number below your real yield bills a partner for grain that was never theirs." — **DROP** most. Label "Expected packaging yield (%)", one line "Used to estimate finished volume for deposits. Set to what you actually get." Rationale → tooltip.

### Production > Export Settings (`ExportSettingsPanel.tsx`) — brewer
- Grid intro "Rows are what you're charging for; columns are who gets billed. For packaging fees, Default prices the unprinted container…" (502–505) — **REPLACE-WITH-UI**: label the axes, rename "Default" → "All partners (unprinted)", printed/unprinted rule in a column-header tooltip.
- "Mixed" badge tooltip — **KEEP**.
- Net terms — fold into label.
- Excise rate table — **KEEP**.

### Production > Partner Portal (`PartnerPortalSettingsPanel.tsx`) — brewer
- Taproom Reserve, four lines with worked example "At 10%, a 40 bbl batch never offers its last 4 bbl" — **SHORTEN** to "Share of every batch never offered to partners." with suffix "% of each batch"; example → tooltip.
- "Who can sign in" paragraph of cross-links — **REPLACE-WITH-UI**: three link buttons.

### Catalog > Square Item Mappings (`MappingGrid.tsx`, `MappingDrawer.tsx`) — brewer
- Grid: no prose, badges with `title=` — **KEEP; model screen.**
- Drawer "Sharing keeps both packagings. A sale drains the oldest stock first, and each one still books the can that actually left." — **SHORTEN** to "Oldest stock sells first."
- Conflict copy — **KEEP**.

### User > Appearance — everyone
- "Light/dark for the brand surfaces — and, when the brand skin is on, the whole internal app. Saved per browser." — **SHORTEN** to "Saved on this device."; the brand caveat confuses non-admins who can't see the toggle.

### Finance > GL Mapping (`gl-mapping/*Panel.tsx`) — admin; densest text in Settings
- Page description — **SHORTEN** to "Assign GL accounts to Square items, expenses, bank activity."
- Counterparties footer (~190 words: "Each counterparty is settled by two questions, and the second only appears when…") — **DROP**; the two column headers and the progressive column hiding already do the work. Keep "Rows appear automatically after a bank sync." as the empty state.
- Refunds footer (~130 words) — **SHORTEN** to two lines; rename section "Refund routing exceptions".
- Sales Tax footer — one line; the liability-only rule is enforced by the dropdown.
- Bank Feeds footer — keep only the closed-months warning.
- Expenses footer — one line.
- Jargon: "Counterparty" → "Payee / payer", "Source account" → "Ramp account".

### Finance > Balance Sheet Accounts (`page.tsx`, `MethodSetupPanel.tsx`) — admin
- Drawer narration ("All three numbers matter…", "The stored contribution is the DIFFERENCE…", "'Right now' is worked out fresh every time this page loads… never stored") — **DROP** all four; labelled rows Reported / Entered / Difference, and a Live vs Last-closed toggle.
- "These steps always run together and cannot be enabled separately." — **REPLACE-WITH-UI**: don't render separate toggles.
- `field.help` for 14 method fields (`lib/finance/balances/methods/definitions.ts`), 2–4 sentences each — ≤12 words each, rationale behind "?".

### Finance > Chart of Accounts — fine. Depreciation — closing paragraph → "Changing a life applies from next month; past months don't change."

### Backfill screens (Finance, Payroll, Tax, Production — all on `BackfillShell`) — admin
- Every screen: `what` + `impacts` + permanent "Irreversible… take a backup first" banner + optional `danger` + result footnote. — **SHORTEN hard**: title, one-line what, "Changes: X, Y" chips, irreversible warning only on the confirm step (it's already two-click). Skip-row semantics → Status tooltip. Rename "Backfill" → "Repair history".

### Payroll > Config / Departments — admin
- "Saving creates the current period if it does not exist yet. The daily cron creates the next…" — **DROP**; system behaviour.
- Tip-pool granularity paragraph — label "Tip pool period" with options.
- Departments: three paragraphs under three dropdowns — label + ≤10-word hint each.

### Environment — admin
- Business timezone paragraph — keep only "Change it only if the taproom physically relocates."
- Users preset-roles note — **KEEP** short.
- GrantMatrix inherit/read/operate/manage — add a one-word gloss (View / Use / Configure).
- Cron "A job with no runs has either never fired or predates run logging." — **DROP**; keep "Schedules run in UTC".

### Tax — admin
- Profile / Filing descriptions — ≤6 words each.
- Template `help` strings ("stored in schedule.config.counties as { code, weight }") — **DROP**; implementation detail.

### Shared chrome
- `SettingsHeader.description` — single string, fine.
- `MappingFrame.footer` — **required** ReactNode under every mapping table. Make optional; intent "one sentence or a tooltip".
- `BackfillShell` — requires `what` and `impacts`, adds a permanent banner, offers `danger`; its own comment says "three things every screen must state before the button". **This is the design causing the paragraphs.** Restructure to summary + confirm-step warning.

---

## 7. Vocabulary to rename where a non-admin reads it

| Current | Recommended | Where |
|---|---|---|
| allocation | share | Production, Batch Log, Export Bay |
| commitment | deal | Intake, Ledger |
| unallocated | unassigned | Batch Log, Ledger |
| shrinkage | loss | Batch Log, Draft Stats |
| entitlement / realizable | owed | Export Bay, Ledger |
| booked / plan | deposit paid / planned | Export Bay |
| write off | mark delivered | Export Bay |
| recount target | (delete; keg size carries it) | Draft Stats |
| Queue swap / Queue beer | Save | Draft Stats |
| Variation | Item | Events |
| phantom | No stock | Shipments |
| Counterparty | Payee / payer | GL Mapping, Bank Ledger |
| Source account | Ramp account | GL Mapping, Expenses |
| Flow | Type / Treatment | Bank Ledger |
| Backfill | Repair history | Settings |
| read / operate / manage | View / Use / Configure | GrantMatrix |
| "as at" | "on" | Period Close |
| GL code alone | "4100 · Taproom Sales" | everywhere |

---

## 8. Recommended order of work

Ranked by (people affected × text removed). Each line is a self-contained PR.

1. **Deposit status chip** replacing `DepositCoverageLine`, Partner Ledger's six-way label, and Invoice preview's per-batch reasons. Brewer-visible; four screens.
2. **Re-home step** pulled out of the ship form into its own step, one shared component (currently three copies). Brewer-visible.
3. **Partner Ledger "Owed X bbl" + ⓘ derivation popover.** Brewer-visible.
4. **Gate or relocate Square drift view** to manager+ / Settings > Catalog. Removes the most technical Taproom screen from viewers in one move.
5. **Draft Stats swap modal → one status line + "Save"**; mechanism into `DraftStatsHelp`. Rename recount target / keg to drain / line-item mapping.
6. **Settings > Production copy pass**: yield, reserve, net terms, export grid intro, "who can sign in" → buttons. Brewer-visible, small PR.
7. **Production vocabulary rename** (§7, first eight rows). Mechanical, wide.
8. **TransferModal**: delete destination box and convert intro; segmented control; capacity beside the input.
9. **Landed cost rename + freight default 0**; delete both callouts.
10. **Achievement**: delete the "two signals" box; ⓘ on tiles; tier select.
11. **Tap cards two numbers; Inventory grid units in header**, no 10 px sub-lines. Floorplan tile text ≥11 px.
12. **Bank Ledger**: per-row effect → option/tooltip; P&L badge; one Refresh. Delete the three transactions footers.
13. **Period Close**: 3-stat strip, pre-filled task inputs with Suggested/Last chips, "stops recomputing" said once.
14. **`BackfillShell` + `MappingFrame.footer` restructure**; then GL Mapping footers and Balance Sheet drawer narration.
15. **Payroll PeriodsTable Reconciled column**; SyncPanel one button; Financials View menu.
