# NC DOR Beer Excise Tax (Form B-C-710) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a second independent tax party — NC DOR Beer Wholesalers/Resident-Brewery Excise Tax Return (Form B-C-710), filed monthly — to `finance > tax`, computed from the export/shipments excise data, with an optional filled-PDF generator.

**Architecture:** The tax module is a party-template plugin system; this adds one new party `nc_dor_beer_excise` (server `TaxPartyTemplate` + pure `derive`/`fieldOwnership` + server `calc` + client `Worksheet`) plus a small extension of the shared identity schema. No generic-core, DB-schema, scheduling, cron, or API-route changes. All figure math lives in ONE pure `derive.ts` shared by the server compute/merge and the client live-edit, mirroring `ncDorSalesUse`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase (service-role admin client), Vitest. Phase C adds `pdf-lib` for AcroForm fill.

**Spec:** `docs/superpowers/specs/2026-07-13-nc-dor-beer-excise-tax-design.md`

## Global Constraints

- **Statutory NC malt-beverage rate: $0.6171/gallon** (form Line 6). Line 6 reads the live configurable `excise_tax_rates` NC gallon row; fallback constant `0.6171` if that row is missing. **Timely-filing discount: 2%** of Line 6.
- **Taxable channels (Line 5): `distribution` + `contract_brewing` + `taproom`.** `wholesale` → Line 4a deduction, never taxed.
- **Period key = `export_transactions.created_at`** (ship/record date), range `[start T00:00:00Z, dayAfter(end) T00:00:00Z)`.
- **Gallons = `volume_bbl × 31`** (`GALLONS_PER_BBL`, `lib/constants/production.ts`), rounded to **whole gallons**; the printed value and Line-6 multiplicand are identical.
- **All money is integer cents.** Gallons are integers. Every rounding uses `Math.round` exactly once at its point of definition.
- Follow `docs/UI_STANDARD.md`: token utilities only, `.inp`/`.inp-sm`/`.btn-*`, `<Field>`, no raw colors, no hand-rolled primitives.
- Every new/modified `lib/` module ships co-located `*.test.ts`; `npm run verify` (lint + typecheck + tests) is the DoD.
- Internal worksheet field keys (authoritative — used by every task):
  - **Gallons (computed):** `gal_distribution`, `gal_contract`, `gal_taproom`, `gal_wholesale`, `gal_produced_for_sale` (L2), `gal_total_available` (L3), `gal_allowable_deductions` (L4a), `gal_taxable` (L5)
  - **Gallons (manual, default 0):** `gal_beginning_inventory` (L1), `gal_deduction_other` (extra 4a), `gal_adjustments_part3` (L4b), `gal_military_part4` (L4c), `gal_ending_inventory` (L4d)
  - **Rate (computed):** `nc_excise_rate_micros` (micro-dollars per gallon; `0.6171 → 617100`)
  - **Money cents (computed):** `cents_excise_due` (L6), `cents_discount` (L7), `cents_net_tax_due` (L8), `cents_total_payment_due` (L11)
  - **Money cents (manual, default 0):** `cents_penalty` (L9), `cents_interest` (L10)
  - **Flags/other (manual):** `flag_timely` (1/0, default 1), `flag_amended` (1/0, default 0), `flag_no_transactions` (1/0, default 0), `signer_date` (text, default "")

## Execution Budget

- **Mode:** written plan (>6 files), executed via subagent-driven-development or inline executing-plans.
- **Locality groups:** (1) `lib/tax/parties/ncDorBeerExcise/` + shared identity/states, (2) `app/finance/tax/parties/NcDorBeerExcise/` + client math, (3) PDF fill (Phase C).
- **Spawn cap = 3 + 2 = 5.** Executor STOPS and reports before exceeding it.
- **Model:** implementation → Sonnet; mechanical (constants/schema extension) → Haiku; final whole-branch review → Opus (once).
- **Phases:** A (Tasks 1–6) numbers engine → B (Tasks 7–9) worksheet UI + rollout → C (Tasks 10–12) PDF, stretch. A+B is a complete, usable module; C is optional.

| Task | Deliverable | Model |
|---|---|---|
| 1 | `rates.ts` constants + reference data | Haiku |
| 2 | `derive.ts` pure waterfall math | Sonnet |
| 3 | `fieldOwnership.ts` classifier | Sonnet |
| 4 | `calc.ts` shipments query + warnings | Sonnet |
| 5 | `template.ts` assemble + register | Sonnet |
| 6 | shared `usStates.ts` + `IDENTITY_SCHEMA` extension | Haiku |
| 7 | client `beerExciseWorksheetMath.ts` | Sonnet |
| 8 | client `fieldOwnership.ts` + `getTotalDueCents` | Haiku |
| 9 | `Worksheet.tsx` + registry entry | Sonnet |
| 10 | rate rollout + browser verification | Sonnet |
| 11 | `pdfFieldMap.ts` + `fillBc710` (Phase C) | Sonnet |
| 12 | template storage + fill route + download button (Phase C) | Sonnet |

---

## Phase A — Numbers engine

### Task 1: Rates & reference constants

**Files:**
- Create: `lib/tax/parties/ncDorBeerExcise/rates.ts`
- Test: `lib/tax/parties/ncDorBeerExcise/rates.test.ts`

**Interfaces:**
- Produces: `NC_EXCISE_RATE_USD_PER_GALLON = 0.6171`, `NC_EXCISE_RATE_MICROS_FALLBACK = 617100`, `DISCOUNT_RATE = 0.02`, `TAXABLE_CHANNELS: ReadonlySet<string>` (`distribution`,`contract_brewing`,`taproom`), `WHOLESALE_CHANNEL = "wholesale"`, `BEER_EXCISE_REFERENCE: ReferenceSpec`, `usdToMicros(usd: number): number` (`Math.round(usd * 1_000_000)`).

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { NC_EXCISE_RATE_MICROS_FALLBACK, TAXABLE_CHANNELS, usdToMicros, DISCOUNT_RATE } from "./rates";

describe("beer excise rates", () => {
  it("fallback micros match the statutory $0.6171/gal", () => {
    expect(NC_EXCISE_RATE_MICROS_FALLBACK).toBe(617100);
    expect(usdToMicros(0.6171)).toBe(617100);
  });
  it("taxes distribution/contract/taproom but not wholesale", () => {
    expect(TAXABLE_CHANNELS.has("distribution")).toBe(true);
    expect(TAXABLE_CHANNELS.has("contract_brewing")).toBe(true);
    expect(TAXABLE_CHANNELS.has("taproom")).toBe(true);
    expect(TAXABLE_CHANNELS.has("wholesale")).toBe(false);
  });
  it("discount is 2%", () => expect(DISCOUNT_RATE).toBe(0.02));
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run lib/tax/parties/ncDorBeerExcise/rates.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement `rates.ts`** — export the constants above; `usdToMicros = (usd) => Math.round(usd * 1_000_000)`; `BEER_EXCISE_REFERENCE: ReferenceSpec` with a "Rate" table (`61.71¢ per gallon`, `2% timely discount`) and `notes` covering: monthly filing due the 15th of the following month; taxable channels = distribution + contract brewing + taproom; wholesale sold to other NC wholesalers is a Line 4a deduction; rate is read live from the excise-tax settings row. Import `ReferenceSpec` type from `@/lib/tax/types`.

- [ ] **Step 4: Run test to verify it passes** — same command → PASS.

- [ ] **Step 5: Commit** — `git add lib/tax/parties/ncDorBeerExcise/rates.ts lib/tax/parties/ncDorBeerExcise/rates.test.ts && git commit -m "feat(tax): beer excise rate + reference constants"`

---

### Task 2: Pure figure derivation (`derive.ts`)

**Files:**
- Create: `lib/tax/parties/ncDorBeerExcise/derive.ts`
- Test: `lib/tax/parties/ncDorBeerExcise/derive.test.ts`

**Interfaces:**
- Consumes: `NC_EXCISE_RATE_MICROS_FALLBACK`, `DISCOUNT_RATE` from `./rates`; `WorksheetFields` from `@/lib/tax/types`.
- Produces: `deriveBeerExciseFigures(fields: WorksheetFields): WorksheetFields` — returns a NEW field set with all computed keys re-derived from the channel gallons + manual fields; pass-through for unrecognized keys. Zero server imports (client-importable).

**Math (from Global Constraints keys):**
```
gal_produced_for_sale    = gal_distribution + gal_contract + gal_taproom + gal_wholesale        // L2
gal_total_available      = gal_beginning_inventory + gal_produced_for_sale                       // L3
gal_allowable_deductions = gal_wholesale + gal_deduction_other                                   // L4a
gal_taxable = max(0, gal_total_available − gal_allowable_deductions
                       − gal_adjustments_part3 − gal_military_part4 − gal_ending_inventory)      // L5 (floored ≥0)
rateMicros            = num(nc_excise_rate_micros) || NC_EXCISE_RATE_MICROS_FALLBACK
cents_excise_due      = Math.round(gal_taxable * rateMicros / 10000)                             // L6
cents_discount        = num(flag_timely) ? Math.round(cents_excise_due * DISCOUNT_RATE) : 0      // L7
cents_net_tax_due     = cents_excise_due − cents_discount                                        // L8
cents_total_payment_due = cents_net_tax_due + num(cents_penalty) + num(cents_interest)           // L11
```
Note: `rateMicros/10000` converts micro-dollars/gal to cents/gal (`617100/10000 = 61.71`), so `gal × 61.71` cents.

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, it, expect } from "vitest";
import { deriveBeerExciseFigures } from "./derive";

const base = {
  gal_distribution: 1000, gal_contract: 200, gal_taproom: 300, gal_wholesale: 500,
  gal_beginning_inventory: 0, gal_deduction_other: 0, gal_adjustments_part3: 0,
  gal_military_part4: 0, gal_ending_inventory: 0,
  nc_excise_rate_micros: 617100, flag_timely: 1, cents_penalty: 0, cents_interest: 0,
};

describe("deriveBeerExciseFigures", () => {
  it("waterfall: L2 all channels, L4a = wholesale, L5 = taxable channels", () => {
    const f = deriveBeerExciseFigures(base);
    expect(f.gal_produced_for_sale).toBe(2000);       // 1000+200+300+500
    expect(f.gal_total_available).toBe(2000);
    expect(f.gal_allowable_deductions).toBe(500);     // wholesale
    expect(f.gal_taxable).toBe(1500);                 // 1000+200+300
  });
  it("L6 = taxable gallons × 61.71¢, L7 = 2% when timely, L8/L11 roll up", () => {
    const f = deriveBeerExciseFigures(base);
    expect(f.cents_excise_due).toBe(Math.round(1500 * 61.71));  // 92565
    expect(f.cents_discount).toBe(Math.round(92565 * 0.02));    // 1851
    expect(f.cents_net_tax_due).toBe(92565 - 1851);
    expect(f.cents_total_payment_due).toBe(92565 - 1851);
  });
  it("no discount when not timely; penalty+interest add to L11", () => {
    const f = deriveBeerExciseFigures({ ...base, flag_timely: 0, cents_penalty: 500, cents_interest: 250 });
    expect(f.cents_discount).toBe(0);
    expect(f.cents_total_payment_due).toBe(f.cents_excise_due as number + 750);
  });
  it("extra manual deductions & inventory reduce L5; floored at 0", () => {
    const f = deriveBeerExciseFigures({ ...base, gal_deduction_other: 100, gal_ending_inventory: 50 });
    expect(f.gal_taxable).toBe(1350);
    const z = deriveBeerExciseFigures({ ...base, gal_military_part4: 99999 });
    expect(z.gal_taxable).toBe(0);
  });
  it("falls back to statutory micros when rate field absent", () => {
    const { nc_excise_rate_micros: _omit, ...noRate } = base;
    const f = deriveBeerExciseFigures(noRate);
    expect(f.cents_excise_due).toBe(Math.round(1500 * 61.71));
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run lib/tax/parties/ncDorBeerExcise/derive.test.ts` → FAIL.

- [ ] **Step 3: Implement `deriveBeerExciseFigures`** per the Math block. Use a local `num(v) = Number(v ?? 0)`, copy input into a new object, assign every computed key, return it. Keep it a single pure function; no other exports needed.

- [ ] **Step 4: Run test to verify it passes** — PASS.

- [ ] **Step 5: Commit** — `git add lib/tax/parties/ncDorBeerExcise/derive.ts lib/tax/parties/ncDorBeerExcise/derive.test.ts && git commit -m "feat(tax): beer excise pure figure derivation"`

---

### Task 3: Field ownership (`fieldOwnership.ts`)

**Files:**
- Create: `lib/tax/parties/ncDorBeerExcise/fieldOwnership.ts`
- Test: `lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts`

**Interfaces:**
- Consumes: `FieldOwnership` from `@/lib/tax/types`.
- Produces: `resolveBeerFieldOwnership(key: string): FieldOwnership`, `isComputedField(key: string): boolean`. Zero server imports.

Computed set (see Global Constraints): `gal_distribution, gal_contract, gal_taproom, gal_wholesale, gal_produced_for_sale, gal_total_available, gal_allowable_deductions, gal_taxable, nc_excise_rate_micros, cents_excise_due, cents_discount, cents_net_tax_due, cents_total_payment_due`. Everything else (manual fields + unknown) → `manual` (safe default preserved by `mergeWorksheet`).

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, it, expect } from "vitest";
import { resolveBeerFieldOwnership, isComputedField } from "./fieldOwnership";

describe("beer excise field ownership", () => {
  it.each(["gal_taxable","cents_excise_due","cents_total_payment_due","nc_excise_rate_micros","gal_produced_for_sale"])(
    "%s is computed", (k) => expect(resolveBeerFieldOwnership(k)).toBe("computed"));
  it.each(["cents_penalty","cents_interest","flag_timely","gal_ending_inventory","gal_adjustments_part3","signer_date"])(
    "%s is manual", (k) => expect(resolveBeerFieldOwnership(k)).toBe("manual"));
  it("unknown keys default to manual", () => expect(resolveBeerFieldOwnership("mystery")).toBe("manual"));
  it("isComputedField mirrors resolve", () => expect(isComputedField("gal_taxable")).toBe(true));
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Implement** with a `COMPUTED_KEYS = new Set([...])` and `resolveBeerFieldOwnership = (k) => COMPUTED_KEYS.has(k) ? "computed" : "manual"`; `isComputedField = (k) => resolveBeerFieldOwnership(k) === "computed"`.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add lib/tax/parties/ncDorBeerExcise/fieldOwnership.ts lib/tax/parties/ncDorBeerExcise/fieldOwnership.test.ts && git commit -m "feat(tax): beer excise field ownership"`

---

### Task 4: Shipments compute engine (`calc.ts`)

**Files:**
- Create: `lib/tax/parties/ncDorBeerExcise/calc.ts`
- Test: `lib/tax/parties/ncDorBeerExcise/calc.test.ts`

**Interfaces:**
- Consumes: `TAXABLE_CHANNELS`, `WHOLESALE_CHANNEL`, `NC_EXCISE_RATE_MICROS_FALLBACK` from `./rates`; `deriveBeerExciseFigures` from `./derive`; `GALLONS_PER_BBL` from `@/lib/constants/production`; `addDaysStr` from `@/lib/utils/datetime`; `ComputeContext`, `TaxPeriod`, `WorksheetData`, `WorksheetFields` from `@/lib/tax/types`; `SupabaseClient` from `@supabase/supabase-js`.
- Produces:
  - `fetchExciseData(sb, period): Promise<{ gallonsByChannel: Record<string, number>; storedNcCents: number; missingDetailTxns: number }>`
  - `fetchNcRateMicros(sb): Promise<number | null>` (reads active `excise_tax_rates` gallon row whose `name` contains "nc"; returns `usdToMicros(rate_usd)` or `null`)
  - `computeBeerExciseFigures(args: { gallonsByChannel; ncRateMicros: number; storedNcCents: number; missingDetailTxns: number }): WorksheetData`
  - `computeBeerExciseWorksheet(ctx: ComputeContext, sb?: SupabaseClient): Promise<WorksheetData>`

**Query (in `fetchExciseData`):** `export_transactions.select("channel, volume_bbl, export_transaction_taxes ( tax_name, amount_usd )").gte("created_at", startTs).lt("created_at", endExclusiveTs)` where `startTs = ${period.start}T00:00:00Z`, `endExclusiveTs = ${addDaysStr(period.end,1)}T00:00:00Z`. Per row: add `volume_bbl` to its channel bucket; if channel ∈ `TAXABLE_CHANNELS`, sum `amount_usd` of child rows whose `tax_name.toLowerCase().includes("nc")` into `storedNcDollars`, and if `volume_bbl > 0` with no NC child row, increment `missingDetailTxns`. Return `gallonsByChannel[ch] = Math.round(bbl * GALLONS_PER_BBL)` per channel, `storedNcCents = Math.round(storedNcDollars * 100)`.

**Warnings (in `computeBeerExciseFigures`):**
- Rate drift: `tolerance = Math.max(100, Math.round(storedNcCents * 0.001))`; if `Math.abs(cents_excise_due − storedNcCents) > tolerance` → push a warning naming both figures (note: legacy rows stored at $0.62 or missing detail can trigger this).
- Coverage: if `missingDetailTxns > 0` → push a warning to backfill excise detail before filing.

`computeBeerExciseWorksheet` glue: resolve period; `client = sb ?? (await import("@/lib/supabase/admin")).createSupabaseAdminClient()`; `data = await fetchExciseData(client, ctx.period)`; `micros = (await fetchNcRateMicros(client)) ?? NC_EXCISE_RATE_MICROS_FALLBACK` (push a warning if it fell back); assemble the initial field set (channel gallons + `nc_excise_rate_micros` + all manual defaults from Global Constraints), then `computeBeerExciseFigures`. `meta = { computedAt: new Date().toISOString(), provenance: "export_transactions" }`.

- [ ] **Step 1: Write the failing tests** (stubbed `sb`, no live DB)
```ts
import { describe, it, expect } from "vitest";
import { computeBeerExciseFigures } from "./calc";

describe("computeBeerExciseFigures", () => {
  const g = { distribution: 1000, contract_brewing: 200, taproom: 300, wholesale: 500 };
  it("maps channel gallons onto the waterfall and taxes only liable channels", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 0 });
    expect(w.fields.gal_taxable).toBe(1500);
    expect(w.fields.gal_allowable_deductions).toBe(500);
    expect(w.fields.cents_excise_due).toBe(Math.round(1500 * 61.71));
    expect(w.warnings ?? []).toHaveLength(0);
  });
  it("warns on rate drift beyond tolerance", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 80000, missingDetailTxns: 0 });
    expect(w.warnings?.some((s) => /differs|drift|Review/i.test(s))).toBe(true);
  });
  it("warns when taxable rows are missing NC excise detail", () => {
    const w = computeBeerExciseFigures({ gallonsByChannel: g, ncRateMicros: 617100, storedNcCents: 92565, missingDetailTxns: 3 });
    expect(w.warnings?.some((s) => /detail|coverage|backfill/i.test(s))).toBe(true);
  });
});
```
(Optional: add a `fetchExciseData` test with a hand-rolled `sb` stub whose `.select().gte().lt()` resolves `{ data: [ {channel:"taproom", volume_bbl:10, export_transaction_taxes:[{tax_name:"NC Excise Tax", amount_usd:191.9}]} ], error:null }`, asserting `gallonsByChannel.taproom === 310`.)

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run lib/tax/parties/ncDorBeerExcise/calc.test.ts` → FAIL.
- [ ] **Step 3: Implement `calc.ts`** per Interfaces/Query/Warnings above.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add lib/tax/parties/ncDorBeerExcise/calc.ts lib/tax/parties/ncDorBeerExcise/calc.test.ts && git commit -m "feat(tax): beer excise shipments compute engine"`

---

### Task 6: Shared US-states constant + identity-schema extension

> Ordered before Task 5 because `template.ts`'s `settingsSchema` imports `US_STATES` and spreads the extended `IDENTITY_SCHEMA`.

**Files:**
- Create: `lib/tax/usStates.ts`
- Modify: `lib/tax/identity.ts`
- Test: `lib/tax/usStates.test.ts`

**Interfaces:**
- Produces: `US_STATES: { value: string; label: string }[]` (the 50 states + DC + PR, values are 2-letter codes matching the BC-710 dropdown list: AK, AL, AR, AZ, CA, CO, CT, DC, DE, FL, GA, HI, IA, ID, IL, IN, KS, KY, LA, MA, MD, ME, MI, MN, MO, MS, MT, NC, ND, NE, NH, NJ, NM, NV, NY, OH, OK, OR, PA, PR, RI, SC, SD, TN, TX, UT, VA, VT, WA, WI, WV, WY).
- `IDENTITY_SCHEMA` gains, appended after `contact_phone`: `legal_name` (text), `trade_name` (text), `mailing_address` (text), `city` (text), `state` (select, `options: US_STATES`), `zip` (text). `fein`/`ssn`/`account_id` unchanged.

- [ ] **Step 1: Write the failing test**
```ts
import { describe, it, expect } from "vitest";
import { US_STATES } from "./usStates";
import { IDENTITY_SCHEMA } from "./identity";

describe("shared identity extension", () => {
  it("US_STATES includes NC and is 52 entries", () => {
    expect(US_STATES.find((s) => s.value === "NC")?.label).toBe("North Carolina");
    expect(US_STATES).toHaveLength(52);
  });
  it("IDENTITY_SCHEMA carries business-identity fields", () => {
    const keys = IDENTITY_SCHEMA.map((f) => f.key);
    for (const k of ["legal_name","trade_name","mailing_address","city","state","zip"]) expect(keys).toContain(k);
    expect(IDENTITY_SCHEMA.find((f) => f.key === "state")?.type).toBe("select");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run lib/tax/usStates.test.ts` → FAIL.
- [ ] **Step 3: Implement** `lib/tax/usStates.ts` (the array) and append the six `FieldSpec`s to `IDENTITY_SCHEMA` in `lib/tax/identity.ts` (import `US_STATES`).
- [ ] **Step 4: Run test to verify it passes** — PASS. Also run `npx vitest run lib/tax/identityForm.test.ts lib/tax/profiles.test.ts` to confirm no regressions from the widened schema.
- [ ] **Step 5: Commit** — `git add lib/tax/usStates.ts lib/tax/usStates.test.ts lib/tax/identity.ts && git commit -m "feat(tax): shared US states + business-identity fields on identity schema"`

---

### Task 5: Party template (`template.ts`) + registration

**Files:**
- Create: `lib/tax/parties/ncDorBeerExcise/template.ts`
- Modify: `lib/tax/parties/index.ts` (add `import "./ncDorBeerExcise/template";`)
- Test: `lib/tax/parties/ncDorBeerExcise/template.test.ts`

**Interfaces:**
- Consumes: `monthPeriod` (`@/lib/tax/period`), `resolveDueDate`/`DueRule` (`@/lib/tax/dueDate`), `registerParty` (`@/lib/tax/registry`), `IDENTITY_SCHEMA` (`@/lib/tax/identity`), `US_STATES` (`@/lib/tax/usStates`), `computeBeerExciseWorksheet` (`./calc`), `deriveBeerExciseFigures` (`./derive`), `resolveBeerFieldOwnership` (`./fieldOwnership`), `BEER_EXCISE_REFERENCE` (`./rates`).
- Produces: `export const ncDorBeerExciseTemplate: TaxPartyTemplate`; side-effect `registerParty(...)`.

Template values: `key: "nc_dor_beer_excise"`, `label: "NC DOR — Beer Excise Tax (B-C-710)"`, `supportedFrequencies: ["monthly"]`. `defaultDueRule(freq)` → monthly `{ monthOffset: 1, day: 15 }`, else throw. `computePeriod("monthly", ref)` → `{ ...monthPeriod(ref), due: resolveDueDate(end, defaultDueRule("monthly")) }`, else throw. `fieldOwnership` = `Proxy` over `resolveBeerFieldOwnership` (copy the pattern from `ncDorSalesUse/template.ts:72-77`). `mergeWorksheet(current, recomputed)` = same pattern as `ncDorSalesUse/template.ts:90-104` but re-derive via `deriveBeerExciseFigures`. `settingsSchema = [...IDENTITY_SCHEMA, {key:"abc_permit_number",label:"ABC Permit Number",type:"text"}, {key:"state_of_domicile",label:"State of Domicile",type:"select",options:US_STATES}, {key:"fax_number",label:"Fax",type:"tel"}, {key:"signer_title",label:"Signer Title",type:"text"}]`. `scheduleConfigSchema: []`. `referenceView: BEER_EXCISE_REFERENCE`. `recomputeLabel: "Recompute from shipments"`. `worksheetComponent: "nc_dor_beer_excise"`.

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, it, expect } from "vitest";
import "@/lib/tax/parties";                    // side-effect registry load
import { getParty } from "@/lib/tax/registry";

describe("nc_dor_beer_excise template", () => {
  const p = getParty("nc_dor_beer_excise")!;
  it("is registered, monthly only", () => {
    expect(p.label).toMatch(/Beer Excise/);
    expect(p.supportedFrequencies).toEqual(["monthly"]);
  });
  it("monthly period is due the 15th of the following month", () => {
    const per = p.computePeriod("monthly", new Date("2026-03-10T12:00:00Z"));
    expect(per.start).toBe("2026-03-01");
    expect(per.end).toBe("2026-03-31");
    expect(per.due).toBe("2026-04-15");
  });
  it("quarterly is unsupported", () => expect(() => p.computePeriod("quarterly" as any, new Date())).toThrow());
  it("settings schema includes shared identity + beer-only fields", () => {
    const keys = p.settingsSchema.map((f) => f.key);
    expect(keys).toEqual(expect.arrayContaining(["legal_name","fein","abc_permit_number","state_of_domicile","signer_title"]));
  });
  it("mergeWorksheet preserves manual penalty across recompute and re-derives L11", () => {
    const current = { fields: { cents_penalty: 500, gal_distribution: 1000, gal_contract:0, gal_taproom:0, gal_wholesale:0, flag_timely:1, nc_excise_rate_micros:617100 } };
    const recomputed = { fields: { cents_penalty: 0, gal_distribution: 2000, gal_contract:0, gal_taproom:0, gal_wholesale:0, flag_timely:1, nc_excise_rate_micros:617100 }, meta:{} };
    const m = p.mergeWorksheet(current as any, recomputed as any);
    expect(m.fields.gal_taxable).toBe(2000);          // computed taken from recomputed
    expect(m.fields.cents_penalty).toBe(500);          // manual preserved from current
    expect(m.fields.cents_total_payment_due).toBe((m.fields.cents_net_tax_due as number) + 500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — `npx vitest run lib/tax/parties/ncDorBeerExcise/template.test.ts` → FAIL.
- [ ] **Step 3: Implement `template.ts`** (assemble + `registerParty`) and add the import line to `lib/tax/parties/index.ts`.
- [ ] **Step 4: Run test to verify it passes** — PASS. Also `npx vitest run lib/tax/registry.test.ts` to confirm the registry still lists both parties.
- [ ] **Step 5: Commit** — `git add lib/tax/parties/ncDorBeerExcise/template.ts lib/tax/parties/ncDorBeerExcise/template.test.ts lib/tax/parties/index.ts && git commit -m "feat(tax): register NC DOR beer excise party template"`

- [ ] **Step 6: Phase A gate** — run `npm run verify`; expect lint+typecheck clean and all new tests green. Fix before proceeding.

---

## Phase B — Worksheet UI + rollout

### Task 7: Client worksheet math (`beerExciseWorksheetMath.ts`)

**Files:**
- Create: `lib/tax/beerExciseWorksheetMath.ts`
- Test: `lib/tax/beerExciseWorksheetMath.test.ts`

**Interfaces:**
- Consumes: `deriveBeerExciseFigures` (`./parties/ncDorBeerExcise/derive`); `centsToDollarString`/`dollarStringToCents` (re-imported from `./ncDorWorksheetMath` — generic money-string helpers).
- Produces: `recomputeClientBeerTotals(fields): WorksheetFields` (= `deriveBeerExciseFigures`); `gallonsToString(v): string` (`String(Math.max(0, Math.round(Number(v ?? 0))))`); `stringToGallons(s): number` (`""`/non-numeric → 0, else `Math.max(0, Math.round(Number(s)))`); re-export `centsToDollarString`, `dollarStringToCents`.

- [ ] **Step 1: Write the failing tests**
```ts
import { describe, it, expect } from "vitest";
import { recomputeClientBeerTotals, gallonsToString, stringToGallons } from "./beerExciseWorksheetMath";

describe("beer worksheet client math", () => {
  it("recompute mirrors server derive", () => {
    const f = recomputeClientBeerTotals({ gal_distribution:1000, gal_contract:0, gal_taproom:0, gal_wholesale:0, flag_timely:1, nc_excise_rate_micros:617100 });
    expect(f.gal_taxable).toBe(1000);
    expect(f.cents_excise_due).toBe(Math.round(1000*61.71));
  });
  it("gallon string round-trips as whole gallons", () => {
    expect(gallonsToString(310)).toBe("310");
    expect(stringToGallons("310.7")).toBe(311);
    expect(stringToGallons("")).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Implement** the four exports above.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add lib/tax/beerExciseWorksheetMath.ts lib/tax/beerExciseWorksheetMath.test.ts && git commit -m "feat(tax): beer excise client worksheet math"`

---

### Task 8: Client field-ownership re-export + total

**Files:**
- Create: `app/finance/tax/parties/NcDorBeerExcise/fieldOwnership.ts`

**Interfaces:**
- Produces: re-export `resolveBeerFieldOwnership`, `isComputedField` from `@/lib/tax/parties/ncDorBeerExcise/fieldOwnership`; `getTotalDueCents(fields): number | null` reading `cents_total_payment_due` (`v == null ? null : Number(v)`).

- [ ] **Step 1: Implement** the thin re-export + `getTotalDueCents` (mirror `NcDorSalesUse/fieldOwnership.ts`). No separate test file — covered by Task 3 (server) + Task 9 wiring.
- [ ] **Step 2: Typecheck** — `npx tsc --noEmit` (or defer to the Task 9 verify) → clean.
- [ ] **Step 3: Commit** — `git add app/finance/tax/parties/NcDorBeerExcise/fieldOwnership.ts && git commit -m "feat(tax): beer excise client field ownership + total"`

---

### Task 9: Worksheet component + registry entry

**Files:**
- Create: `app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx`
- Modify: `app/finance/tax/parties/registry.ts` (add `nc_dor_beer_excise` entry)

**Interfaces:**
- Consumes: `PartyWorksheetProps` from `../registry`; `recomputeClientBeerTotals`, `gallonsToString`, `stringToGallons`, `centsToDollarString`, `dollarStringToCents` from `@/lib/tax/beerExciseWorksheetMath`; `isComputedField` from `./fieldOwnership`; `getTotalDueCents` from `./fieldOwnership`; `fmtCents` from `@/lib/utils/formatting`.
- Registry entry: `nc_dor_beer_excise: { Worksheet: NcDorBeerExciseWorksheet, getTotalDueCents }` (import both from `./NcDorBeerExcise/...`).

**Component structure** (default export `NcDorBeerExciseWorksheet(props: PartyWorksheetProps)`), following the `NcDorSalesUse/Worksheet.tsx` patterns (local-state inputs keyed by `computedAt` generation; `updateField(key,val)` calls `onFieldsChange(recomputeClientBeerTotals({ ...fields, [key]: val }))`; no-op when `readOnly`):
- **Part 1 — computation** rows L1–L11, each label + value. Computed keys (`isComputedField`) render read-only: gallons via `gallonsToString`, cents via `fmtCents`. Manual gallon fields (`gal_beginning_inventory`, `gal_deduction_other`, `gal_adjustments_part3`, `gal_military_part4`, `gal_ending_inventory`) render a whole-number `.inp-sm` input (`type="number" step="1"`) committing `stringToGallons`. Manual cents fields (`cents_penalty`, `cents_interest`) render a money `.inp-sm` input committing `dollarStringToCents`, seeded with `centsToDollarString`. Both use `key={`${fieldKey}-${generation}`}` so a recompute resyncs.
- **Toggles:** `flag_timely` (checkbox "Return + full payment filed timely (2% discount)"), `flag_amended` ("Amended return"), `flag_no_transactions` ("No transactions this period"). Store `1`/`0`; `updateField` on change.
- **Schedule summary (Part 2):** read-only table with a row per taxable/deduction channel — Distribution (`gal_distribution`), Contract brewing (`gal_contract`), Taproom (`gal_taproom`), Wholesale (`gal_wholesale`, labeled "deduction") — plus a total = `gal_produced_for_sale`. Pure view over computed fields; no inputs.
- **Signature:** `signer_date` text `.inp-sm` (manual). Signer title is display-only from settings (shown by the shell's identity card; no worksheet field).
- Emphasis styling on L6/L8/L11 (`font-semibold text-strong`), tokens only.

- [ ] **Step 1: Write a smoke test** (render with representative fields, assert key values shown & an edit recomputes)
```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import Worksheet from "./Worksheet";

const fields = { gal_distribution:1000, gal_contract:200, gal_taproom:300, gal_wholesale:500,
  gal_beginning_inventory:0, gal_deduction_other:0, gal_adjustments_part3:0, gal_military_part4:0, gal_ending_inventory:0,
  gal_produced_for_sale:2000, gal_total_available:2000, gal_allowable_deductions:500, gal_taxable:1500,
  nc_excise_rate_micros:617100, flag_timely:1, cents_penalty:0, cents_interest:0,
  cents_excise_due:92565, cents_discount:1851, cents_net_tax_due:90714, cents_total_payment_due:90714, signer_date:"" };

describe("NcDorBeerExciseWorksheet", () => {
  it("shows taxable gallons and total due", () => {
    render(<Worksheet fields={fields} onFieldsChange={() => {}} />);
    expect(screen.getByText(/1,?500/)).toBeInTheDocument();     // taxable gallons
    expect(screen.getByText(/907\.14/)).toBeInTheDocument();    // $ total due
  });
  it("editing penalty emits a recomputed field set", () => {
    const onChange = vi.fn();
    render(<Worksheet fields={fields} onFieldsChange={onChange} />);
    // locate the penalty money input by its row and type a value
    // (selector depends on final markup; assert onChange called with cents_total_payment_due > 90714)
  });
});
```
(If the repo has no React Testing Library set up for tax worksheets, model the test after any existing `app/**/*.test.tsx`; otherwise keep the first assertion-only test and rely on Task 10 browser verification for interaction.)

- [ ] **Step 2: Run test to verify it fails** — FAIL.
- [ ] **Step 3: Implement `Worksheet.tsx`** per structure above, then add the registry entry.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git add app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx app/finance/tax/parties/registry.ts && git commit -m "feat(tax): beer excise worksheet component + registry entry"`

---

### Task 10: Rate rollout + end-to-end browser verification

**Files:** none (operational + verification).

- [ ] **Step 1: Set the NC rate to $0.6171** — in the running app, `finance > settings > excise-tax`, edit the active NC gallon `excise_tax_rates` row `rate_usd` from `0.62` to `0.6171`. (No migration; user-editable config.) Record the change.
- [ ] **Step 2: Create the beer-excise schedule + identity** — in `finance > settings > tax-filing`, select the new party, fill business identity (legal name, address, FEIN, NCDOR beer account #) + beer fields (ABC permit, state of domicile, signer title). In `finance > tax`, create a monthly schedule for `nc_dor_beer_excise`.
- [ ] **Step 3: Verify a period end-to-end** — open a generated task, Recompute, and confirm via the browser preview tools: channel gallons populate, L5 taxable = distribution+contract+taproom, L6 = L5 × $0.6171, discount/penalty/interest editable, total-due footer matches L11, warnings banner behaves (drift/coverage). Cross-check L6 against the export/shipments NC excise for the same month.
- [ ] **Step 4: `npm run verify`** — full green (lint + typecheck + tests).
- [ ] **Step 5: Phase B gate** — module is usable and correct; stop here if not doing Phase C.

---

## Phase C — Filled-PDF generator (stretch)

### Task 11: Field map + `fillBc710`

**Files:**
- Modify: `package.json` (add `pdf-lib`)
- Create: `lib/tax/parties/ncDorBeerExcise/pdfFieldMap.ts`
- Create: `lib/tax/parties/ncDorBeerExcise/pdfFieldMap.test.ts`

**Interfaces:**
- Produces:
  - `buildBc710FieldValues(args: { fields: WorksheetFields; profile: Record<string,string>; period: TaxPeriod }): { text: Record<string,string>; checks: Record<string,boolean> }` — pure; maps internal keys + profile + period to the exact `BC710wf_*` AcroForm names (see `scratchpad/fields_by_page.txt`): identity (`BC710wf_Legal Name_1`, `BC710wf_FEIN or SSN`, `BC710wf_NCDOR IDAccount Number`, `BC710wf_ABC Permit Number`, `BC710wf_MailingAddress_1`, `BC710wf_City_1`, `y_BC710wf_state`, `BC710wf_Zip_1`, `y_BC710wf_state2`, `BC710wf_Trade Name_1`, `BC710wf_NameofContactPerson_1`, `BC710wf_PhoneNumber_1`, `BC710wf_FaxNumber_1`, `BC710wf_Title`); period `BC710wf_MMDDYY`; Part 1 lines → `BC710wf_Line1..Line11` (gallons as whole-number strings, money as dollar strings); Part 2 summary rows → `BC710wf_InvoiceDate_1_{n}`/`InvoiceNumber_1_{n}`/`NamesandAddressesofSuppliers_1_{n}`/`MaltBeverageInGallons_1_{n}` for the channel rows + `BC710wf_MaltBeverageInGallons_Total_1`; checkboxes `BC710wf_AmendedReturn`/`BC710wf_NoTransaction` (on-state `/Yes`).
  - `fillBc710(templateBytes: Uint8Array, values: ReturnType<typeof buildBc710FieldValues>): Promise<Uint8Array>` — loads with `pdf-lib`, `form.getTextField(name).setText(v)` for text (wrap each in try/catch so an unknown name is skipped, not fatal), `form.getCheckBox(name).check()` when true, returns `doc.save()`.

- [ ] **Step 1: Add dependency** — `npm install pdf-lib` (commit the lockfile change with this task).
- [ ] **Step 2: Write the failing test** for `buildBc710FieldValues` (pure, no PDF needed)
```ts
import { describe, it, expect } from "vitest";
import { buildBc710FieldValues } from "./pdfFieldMap";

it("maps waterfall + identity + checkboxes to BC710 field names", () => {
  const v = buildBc710FieldValues({
    fields: { gal_produced_for_sale:2000, gal_taxable:1500, cents_excise_due:92565, cents_total_payment_due:90714,
              gal_allowable_deductions:500, gal_distribution:1000, gal_contract:200, gal_taproom:300, gal_wholesale:500, flag_amended:1 },
    profile: { legal_name:"TERRIER POINT BREWING", account_id:"123456", abc_permit_number:"ABC-9", state:"NC" },
    period: { start:"2026-03-01", end:"2026-03-31", due:"2026-04-15" },
  });
  expect(v.text["BC710wf_Line5"]).toBe("1500");
  expect(v.text["BC710wf_Line6"]).toBe("925.65");
  expect(v.text["BC710wf_Legal Name_1"]).toBe("TERRIER POINT BREWING");
  expect(v.text["BC710wf_MaltBeverageInGallons_Total_1"]).toBe("2000");
  expect(v.checks["BC710wf_AmendedReturn"]).toBe(true);
});
```

- [ ] **Step 3: Run test to verify it fails** — FAIL.
- [ ] **Step 4: Implement** `pdfFieldMap.ts` (`buildBc710FieldValues` + `fillBc710`). Gallons via whole-number `String(...)`; cents via `centsToDollars(...).toFixed(2)`. Period `BC710wf_MMDDYY` formatted `MM-DD-YY` from `period.end`.
- [ ] **Step 5: Run test to verify it passes** — PASS.
- [ ] **Step 6: Commit** — `git add package.json package-lock.json lib/tax/parties/ncDorBeerExcise/pdfFieldMap.ts lib/tax/parties/ncDorBeerExcise/pdfFieldMap.test.ts && git commit -m "feat(tax): BC-710 AcroForm field map + pdf-lib fill"`

---

### Task 12: Template storage + fill route + download button

**Files:**
- Create: `app/api/tax/tasks/[id]/bc710/route.ts` (GET → fills + streams the PDF)
- Modify: `app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx` (add a "Generate filled BC-710" `.btn-secondary` that downloads the route response; only for this party)

**Interfaces / behavior:**
- Template storage: user uploads the official fillable BC-710 once into the existing tax Storage bucket at `templates/nc_dor_beer_excise/bc710.pdf` (reuse the `tax-confirmations` bucket via the admin client, or a `tax-templates` prefix). Document the one-time upload step.
- Route: resolve the task (`lib/tax/tasks`), its schedule + profile (`lib/tax/profiles`), and party period; download the template bytes from Storage; `buildBc710FieldValues` + `fillBc710`; respond `application/pdf` with `Content-Disposition: attachment; filename="BC-710-<period>.pdf"`. Guard: 404 if template absent, with a message telling the user to upload it in settings. Auth via existing `getSessionUser` (manager+), matching other tax routes.

- [ ] **Step 1: One-time template upload** — upload the BC-710 fillable PDF to `templates/nc_dor_beer_excise/bc710.pdf` in the tax bucket (document exact bucket/path used).
- [ ] **Step 2: Implement the route** — GET handler per behavior above; reuse existing task/profile fetchers and the admin Storage client.
- [ ] **Step 3: Add the download button** to the beer worksheet (gated to `nc_dor_beer_excise`), linking/fetching the route and triggering a download.
- [ ] **Step 4: Browser-verify** — generate the PDF for a computed period; open it and confirm identity, Lines 1–11, Part 2 summary rows, and checkboxes are populated and internally consistent (printed L6 = printed L5 × 0.6171).
- [ ] **Step 5: `npm run verify`** then **Step 6: Commit** — `git add app/api/tax/tasks/[id]/bc710/route.ts app/finance/tax/parties/NcDorBeerExcise/Worksheet.tsx && git commit -m "feat(tax): generate filled BC-710 PDF from worksheet"`

---

## Self-Review

**Spec coverage:** channels/liability (Tasks 2/4), waterfall + rounding invariant (Task 2), configurable NC rate + fallback (Tasks 1/4/10), drift + taproom coverage warnings (Task 4), monthly due-15th schedule (Task 5), settings/module field split (Tasks 5/6), worksheet UI mirroring the form (Task 9), PDF auto-fill stretch (Tasks 11/12) — all covered.

**Placeholder scan:** no TBD/TODO; every code step shows signatures + concrete tests. Impl bodies intentionally given as signatures + math + acceptance per repo token-discipline rules (`CLAUDE.md`), not full source.

**Type consistency:** field keys are fixed in Global Constraints and reused verbatim across derive (T2), ownership (T3), calc (T4), template merge (T5), client math (T7), worksheet (T9), and PDF map (T11). `getTotalDueCents` reads `cents_total_payment_due` in both T8 and the registry (T9). `computeBeerExciseFigures`/`computeBeerExciseWorksheet` names match between T4 and T5.

**Out of scope (unchanged from spec):** quarterly/annual frequencies; gallon-inventory tracking (L1/L4d fixed 0, manual); Part 3/4 auto-population; altering wholesale/taproom liability elsewhere in the app.
