# Shipment Channel Billing Exceptions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator generate an Export invoice under a *different* channel/model than the shipment was shipped under (a one-off billing exception), without mutating the shipment record, touching commitments, or changing excise-liability reporting.

**Execution Budget:** Mode = **inline** (executing-plans; 4–6 file band per CLAUDE.md tier table — no per-task subagent spawns). Spawn cap = **3** (covers the single final Opus whole-branch review + contingency; STOP and report if exceeded). Token target ≈ **180k**.

**Architecture:** The invoice line-item branch is chosen purely by a channel value. We add an *effective billing channel* that overrides the value read from `export_transactions.channel`, used only to pick the line-item builder in `buildInvoicePreview`. The stored shipment row is never written. The write route derives the shipped channel server-side, requires a reason when billed≠shipped, and persists shipped/billed/reason on the `invoices` row for audit. A pure helper flags the one risky case (crossing the wholesale⇄taxable excise boundary) so the modal can warn.

**Tech Stack:** Next.js 16 App Router, TypeScript, React Query, Supabase (admin client in route handlers), Vitest, Tailwind v4 token utilities.

## Global Constraints

- No business logic in `app/api/**` or components — logic lives in `lib/`. (CLAUDE.md Architecture Priorities)
- New/modified `lib/` business-logic modules ship with co-located `*.test.ts` covering pure logic paths; don't drop coverage below `vitest.config.ts` floor. (CLAUDE.md Rules)
- UI: token utilities only (no raw `zinc/amber/red/green/blue/gray` or hex); use existing primitives — `<Banner tone>`, `.inp-sm`. No hand-rolled primitives. (CLAUDE.md UI Conventions / `docs/UI_STANDARD.md`)
- `export_transactions.channel`, `commitments`, and `checkAndFulfillCommitment` are NEVER written/called by the invoice path.
- The migration is human-gated: do not apply to prod without explicit user OK.
- DoD command: `npm run verify` (lint + typecheck + tests).

## File map

| File | Responsibility | Change |
|---|---|---|
| `lib/tax/parties/ncDorBeerExcise/rates.ts` | Excise treatment constants | Add pure `crossesExciseTreatmentBoundary` |
| `lib/tax/parties/ncDorBeerExcise/rates.test.ts` | rates tests | Add boundary-helper cases |
| `lib/production/exportInvoicePreview.ts` | Invoice preview engine | Add `resolveInvoiceChannel`, `billAsChannel` param, `shippedChannel` in result |
| `lib/production/exportInvoicePreview.test.ts` | preview tests | Add `resolveInvoiceChannel` cases |
| `app/api/production/export/invoice-preview/route.ts` | Preview GET | Thread `billAs` query param |
| `app/production/hooks/queries.ts` | `useInvoicePreview` | Add `billAsChannel` arg + `shippedChannel` type |
| `app/api/production/export/invoice/route.ts` | Invoice write (generate/record) | Derive shipped channel, require reason, persist columns |
| `app/production/components/InvoicePreviewModal.tsx` | Generate Invoice modal | Bill-as selector, reason field, off-model + excise banners |
| `supabase/migrations/20260815_invoice_channel_override.sql` | Schema | 3 nullable `invoices` columns |

## Task order & models

| # | Task | Model | Depends on |
|---|---|---|---|
| 1 | Excise-boundary helper | Haiku | — |
| 2 | Channel resolution in preview engine | Sonnet | — |
| 3 | Preview transport (route + hook) | Haiku | 2 |
| 4 | Migration | Haiku | — |
| 5 | Invoice write route override | Sonnet | 4 |
| 6 | Modal UI | Sonnet | 1, 2, 3 |
| — | Final whole-branch review | Opus | all |

---

### Task 1: Excise-treatment boundary helper

**Files:**
- Modify: `lib/tax/parties/ncDorBeerExcise/rates.ts` (append after `WHOLESALE_CHANNEL`, ~line 30)
- Test: `lib/tax/parties/ncDorBeerExcise/rates.test.ts`

**Interfaces:**
- Produces: `crossesExciseTreatmentBoundary(a: string, b: string): boolean` — true when the two channels fall on opposite sides of the NC excise line (one in `TAXABLE_CHANNELS`, the other not).

- [ ] **Step 1: Write the failing tests**

Add to `lib/tax/parties/ncDorBeerExcise/rates.test.ts`:

```ts
import { crossesExciseTreatmentBoundary } from "./rates";

describe("crossesExciseTreatmentBoundary", () => {
  it("is false for two taxable channels (distribution ↔ contract_brewing)", () => {
    expect(crossesExciseTreatmentBoundary("distribution", "contract_brewing")).toBe(false);
  });
  it("is true when crossing wholesale ↔ a taxable channel", () => {
    expect(crossesExciseTreatmentBoundary("wholesale", "contract_brewing")).toBe(true);
    expect(crossesExciseTreatmentBoundary("distribution", "wholesale")).toBe(true);
  });
  it("is false for wholesale ↔ wholesale", () => {
    expect(crossesExciseTreatmentBoundary("wholesale", "wholesale")).toBe(false);
  });
});
```

(Reuse the existing `describe`/`import` scaffolding already at the top of the file; add `crossesExciseTreatmentBoundary` to the existing import from `./rates` if one is present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/rates.test.ts`
Expected: FAIL — `crossesExciseTreatmentBoundary is not a function` / import error.

- [ ] **Step 3: Implement the helper**

Append to `lib/tax/parties/ncDorBeerExcise/rates.ts` (keep it pure — no server imports, file is client-safe):

```ts
/**
 * True when channels `a` and `b` fall on opposite sides of the NC excise
 * treatment line — one taxable (Line 5), the other the wholesale deduction
 * (Line 4a). Used to warn when a billing-channel override crosses that boundary:
 * excise LIABILITY follows the stored shipment channel, so charging excise on an
 * off-model bill can desync from what TPB actually remits.
 */
export function crossesExciseTreatmentBoundary(a: string, b: string): boolean {
  return TAXABLE_CHANNELS.has(a) !== TAXABLE_CHANNELS.has(b);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run lib/tax/parties/ncDorBeerExcise/rates.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/tax/parties/ncDorBeerExcise/rates.ts lib/tax/parties/ncDorBeerExcise/rates.test.ts
git commit -m "feat(excise): add crossesExciseTreatmentBoundary helper"
```

---

### Task 2: Channel resolution in the preview engine

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts` (result interface ~line 18-32; signature ~line 164-167; guard ~line 192-197; return ~line 366-373)
- Test: `lib/production/exportInvoicePreview.test.ts`

**Interfaces:**
- Produces: `resolveInvoiceChannel(storedChannels: string[], billAsChannel?: string | null): { shippedChannel: string; channel: string }`
- Produces: `buildInvoicePreview(supabase, transactionIds, billAsChannel?: string | null)` — now returns `InvoicePreviewResult & { shippedChannel: string }`.
- Consumes (Task 3, 6): `InvoicePreviewResult.shippedChannel` and the now-effective `channel`.

- [ ] **Step 1: Write the failing tests**

Add to `lib/production/exportInvoicePreview.test.ts`:

```ts
import { resolveInvoiceChannel } from "./exportInvoicePreview";

describe("resolveInvoiceChannel", () => {
  it("returns the shared stored channel when there is no override", () => {
    expect(resolveInvoiceChannel(["distribution", "distribution"])).toEqual({
      shippedChannel: "distribution", channel: "distribution",
    });
  });
  it("throws on mixed stored channels when there is no override", () => {
    expect(() => resolveInvoiceChannel(["distribution", "wholesale"])).toThrow(/same channel/i);
  });
  it("allows mixed stored channels when an override is supplied, reporting shippedChannel='mixed'", () => {
    expect(resolveInvoiceChannel(["distribution", "wholesale"], "contract_brewing")).toEqual({
      shippedChannel: "mixed", channel: "contract_brewing",
    });
  });
  it("uses the override as the effective channel and keeps the single stored channel as shippedChannel", () => {
    expect(resolveInvoiceChannel(["distribution"], "contract_brewing")).toEqual({
      shippedChannel: "distribution", channel: "contract_brewing",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run lib/production/exportInvoicePreview.test.ts`
Expected: FAIL — `resolveInvoiceChannel is not a function`.

- [ ] **Step 3: Implement `resolveInvoiceChannel` + wire it in**

3a. Add the exported helper near the top of `lib/production/exportInvoicePreview.ts` (after the interfaces):

```ts
/**
 * Decide the channel the invoice line-item branch should use.
 * - No override: every selected row must share one stored channel (else throw).
 * - Override: any mix of stored channels is allowed; the effective channel is the
 *   override, and shippedChannel is the single stored channel or "mixed".
 */
export function resolveInvoiceChannel(
  storedChannels: string[],
  billAsChannel?: string | null
): { shippedChannel: string; channel: string } {
  const distinct = new Set(storedChannels);
  const shippedChannel = distinct.size === 1 ? [...distinct][0] : "mixed";
  if (billAsChannel) return { shippedChannel, channel: billAsChannel };
  if (distinct.size !== 1) {
    throw new Error("All selected transactions must share the same channel — mixed-channel invoices are not supported");
  }
  return { shippedChannel, channel: shippedChannel };
}
```

3b. Add `shippedChannel: string;` to the `InvoicePreviewResult` interface (~line 18-32).

3c. Change the signature (~line 164-167) to accept the override:

```ts
export async function buildInvoicePreview(
  supabase: SupabaseClient,
  transactionIds: string[],
  billAsChannel?: string | null
): Promise<InvoicePreviewResult> {
```

3d. Replace the inline single-channel guard (~line 192-197) with:

```ts
  const { shippedChannel, channel } = resolveInvoiceChannel(
    rows.map((r) => r.channel),
    billAsChannel
  );
```

(Delete the old `const channels = new Set(...)` block and the old `const channel = rows[0].channel as string;`. The rest of the function already branches on `channel`, which is now the effective/billed channel.)

3e. Add `shippedChannel` to the returned object (~line 366-373):

```ts
  return {
    customerId,
    customerName: partner.company_name,
    squareCustomerId: partner.square_customer_id,
    lineItems,
    channel,
    shippedChannel,
    defaultDiscountCatalogId,
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run lib/production/exportInvoicePreview.test.ts`
Expected: PASS (new `resolveInvoiceChannel` block + existing `buildExciseTaxLines`/`sumKegCleaningQuantity` blocks all green).

- [ ] **Step 5: Typecheck + commit**

Run: `npx tsc --noEmit`
Expected: no errors.

```bash
git add lib/production/exportInvoicePreview.ts lib/production/exportInvoicePreview.test.ts
git commit -m "feat(export): resolve effective invoice channel with optional billAs override"
```

---

### Task 3: Preview transport — route param + hook arg

**Files:**
- Modify: `app/api/production/export/invoice-preview/route.ts` (~line 11-16)
- Modify: `app/production/hooks/queries.ts` (`useInvoicePreview`, ~line 269-280)

**Interfaces:**
- Consumes: `buildInvoicePreview(supabase, ids, billAs)` (Task 2).
- Produces (Task 6): `useInvoicePreview(transactionIds, billAsChannel?)` returning a result whose type includes `shippedChannel: string`.

- [ ] **Step 1: Thread `billAs` through the GET route**

In `app/api/production/export/invoice-preview/route.ts`, after the `ids` parse and before the `buildInvoicePreview` call:

```ts
  const billAs = req.nextUrl.searchParams.get("billAs");
  // ...
  const preview = await buildInvoicePreview(supabase, ids, billAs);
```

- [ ] **Step 2: Add `billAsChannel` to the hook + `shippedChannel` to its type**

Replace `useInvoicePreview` in `app/production/hooks/queries.ts` with:

```ts
export function useInvoicePreview(transactionIds: string[], billAsChannel?: string | null) {
  return useQuery({
    queryKey: ["production", "invoice-preview", transactionIds, billAsChannel ?? null] as const,
    queryFn: () => fetchJson<{
      customerId: string; customerName: string; squareCustomerId: string | null;
      lineItems: { id: string; description: string; quantity: number; unitPriceCents: number; squareCatalogVariationId: string | null; discountCatalogId?: string | null }[];
      channel: string;
      shippedChannel: string;
      defaultDiscountCatalogId: string | null;
    }>(`/api/production/export/invoice-preview?ids=${transactionIds.join(",")}${billAsChannel ? `&billAs=${encodeURIComponent(billAsChannel)}` : ""}`),
    enabled: transactionIds.length > 0,
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors. (`shippedChannel` is not yet consumed — that's Task 6; the type addition alone must still compile.)

- [ ] **Step 4: Commit**

```bash
git add app/api/production/export/invoice-preview/route.ts app/production/hooks/queries.ts
git commit -m "feat(export): thread billAs channel through invoice-preview transport"
```

---

### Task 4: Migration — audit columns on `invoices`

**Files:**
- Create: `supabase/migrations/20260815_invoice_channel_override.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Invoice-time channel billing override (billing exceptions).
-- Records the channel an invoice was actually BILLED under vs the channel its
-- shipments were SHIPPED under, plus the operator's reason. Nullable so existing
-- and non-override invoices are unaffected. Excise LIABILITY reporting still
-- follows export_transactions.channel — these columns are an invoice/audit trail
-- only. Human-gated (do NOT auto-apply).
alter table public.invoices
  add column if not exists shipped_channel  text,
  add column if not exists billed_channel   text,
  add column if not exists override_reason  text;
```

- [ ] **Step 2: Commit (do not apply)**

```bash
git add supabase/migrations/20260815_invoice_channel_override.sql
git commit -m "feat(invoices): add shipped/billed channel + override reason columns (human-gated)"
```

Note: applying to prod is a separate, explicit, user-authorized step per CLAUDE.md.

---

### Task 5: Invoice write route — override validation + persistence

**Files:**
- Modify: `app/api/production/export/invoice/route.ts` (PostBody ~line 23-32; txs select ~line 54-57; shared derivation after ~line 66; generate upsert ~line 115-128; record upsert ~line 304-317)

**Interfaces:**
- Consumes: request body `bill_as_channel?`, `override_reason?`.
- Produces: `invoices` rows carrying `shipped_channel`, `billed_channel`, `override_reason`.

- [ ] **Step 1: Extend `PostBody`**

Add to the `PostBody` interface:

```ts
  bill_as_channel?: string;
  override_reason?: string;
```

- [ ] **Step 2: Select the stored channel + derive shared override vars**

2a. Add `channel` to the txs select (~line 56):

```ts
    .select("id, recipient_id, recipient_name, status, invoice_id, batch_id, channel")
```

2b. Immediately after `const customerId = txs[0].recipient_id as string;` (~line 66), add:

```ts
  const INVOICEABLE_CHANNELS = new Set(["distribution", "contract_brewing", "wholesale"]);
  const distinctChannels = new Set(txs.map((t) => (t as { channel: string }).channel));
  const shippedChannel = distinctChannels.size === 1 ? [...distinctChannels][0] : "mixed";
  const billedChannel = body.bill_as_channel ?? shippedChannel;
  if (body.bill_as_channel && !INVOICEABLE_CHANNELS.has(body.bill_as_channel)) {
    return NextResponse.json({ error: "bill_as_channel must be distribution | contract_brewing | wholesale" }, { status: 400 });
  }
  if (billedChannel !== shippedChannel && !body.override_reason?.trim()) {
    return NextResponse.json({ error: "override_reason is required when billing under a different channel" }, { status: 400 });
  }
  const overrideReason = body.override_reason?.trim() || null;
```

(This is shared by all actions; for `send`/`sync`/`mark_paid` there is no `bill_as_channel`, so `billedChannel === shippedChannel` and no reason is required — no behavior change.)

- [ ] **Step 3: Persist on the generate upsert**

In the `action === "generate"` invoices upsert object (~line 115-128), add these three fields:

```ts
          shipped_channel: shippedChannel,
          billed_channel: billedChannel,
          override_reason: overrideReason,
```

- [ ] **Step 4: Persist on the record upsert**

In the `action === "record"` invoices upsert object (~line 304-317), add the same three fields:

```ts
          shipped_channel: shippedChannel,
          billed_channel: billedChannel,
          override_reason: overrideReason,
```

- [ ] **Step 5: Typecheck + build**

Run: `npx tsc --noEmit`
Expected: no errors. (Supabase rows are untyped in this repo — memory: no generated types — so the new columns compile without generated-type updates.)

- [ ] **Step 6: Commit**

```bash
git add app/api/production/export/invoice/route.ts
git commit -m "feat(export): persist shipped/billed channel + require reason on invoice override"
```

---

### Task 6: Modal — Bill-as selector, reason, and warnings

**Files:**
- Modify: `app/production/components/InvoicePreviewModal.tsx`

**Interfaces:**
- Consumes: `useInvoicePreview(transactionIds, billAsChannel)` → `{ channel, shippedChannel, ... }` (Task 3); `crossesExciseTreatmentBoundary` (Task 1).

- [ ] **Step 1: Add imports + state**

Add import:

```ts
import { crossesExciseTreatmentBoundary } from "@/lib/tax/parties/ncDorBeerExcise/rates";
```

Add a local label map (module scope, above the component):

```ts
const BILL_AS_OPTIONS: { value: string; label: string }[] = [
  { value: "distribution", label: "Distribution" },
  { value: "contract_brewing", label: "Contract Brewing" },
  { value: "wholesale", label: "Wholesale" },
];
```

Add state inside the component (near the other `useState` calls):

```ts
  const [billAsChannel, setBillAsChannel] = useState<string | null>(null);
  const [overrideReason, setOverrideReason] = useState("");
```

- [ ] **Step 2: Pass the override to the hook + derive override flags**

Change the hook call:

```ts
  const { data, isLoading, error: previewError } = useInvoicePreview(transactionIds, billAsChannel);
```

Add derived values after `const channel = data?.channel ?? null;`:

```ts
  const shippedChannel = data?.shippedChannel ?? null;
  const isOverride = !!shippedChannel && !!channel && channel !== shippedChannel;
  const crossesExcise = isOverride && shippedChannel != null && channel != null
    && crossesExciseTreatmentBoundary(shippedChannel, channel);
```

- [ ] **Step 3: Render the Bill-as selector**

Immediately after the mode-toggle block (~line 213, before the manual-only fields), add a labeled `.inp-sm` select. Selecting the shipped channel clears the override (`null`); any other value sets it:

```tsx
          <div className="space-y-1">
            <label className="text-xs text-secondary">Bill as</label>
            <select
              className="inp-sm w-56"
              value={billAsChannel ?? shippedChannel ?? ""}
              onChange={(e) => setBillAsChannel(e.target.value === shippedChannel ? null : e.target.value)}
            >
              {BILL_AS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>
```

- [ ] **Step 4: Render the off-model + excise banners and the reason field**

Add, right after the selector (all gated on `isOverride`):

```tsx
          {isOverride && (
            <>
              <Banner tone="info">
                Shipped as <span className="font-medium">{shippedChannel}</span>; billing as{" "}
                <span className="font-medium">{channel}</span>. The shipment record and excise reporting are unchanged.
              </Banner>
              {crossesExcise && (
                <Banner tone="danger">
                  This shipment is reported to NC DOR as <span className="font-medium">{shippedChannel}</span>.
                  Billing it as <span className="font-medium">{channel}</span> does not change TPB&rsquo;s excise
                  liability — do not add an excise charge unless you also intend to reclassify the shipment for tax reporting.
                </Banner>
              )}
              <div className="space-y-1">
                <label className="text-xs text-secondary">Reason <span className="text-danger">*</span></label>
                <input
                  className="inp-sm w-full"
                  value={overrideReason}
                  placeholder="e.g. Fortnight pumpkin ale — billed contract per agreement"
                  onChange={(e) => setOverrideReason(e.target.value)}
                />
              </div>
            </>
          )}
```

- [ ] **Step 5: Send override fields + gate the submit**

5a. Add to BOTH fetch bodies in `handleCreate` (the `generate` body ~line 156 and the `record` body ~line 163-171):

```ts
          bill_as_channel: billAsChannel ?? undefined,
          override_reason: isOverride ? overrideReason.trim() : undefined,
```

5b. Update the submit-disabled condition (~line 415) to also block an override with no reason:

```ts
              disabled={creating || effectiveLineItems.length === 0 || (invoiceMode === "manual" && !manualValid) || (isOverride && !overrideReason.trim())}
```

- [ ] **Step 6: Verify in the browser**

Start the dev server and open Production → Export → Shipments. Select a partner shipment (e.g. a distribution canning shipment), open Generate Invoice, and:
- Confirm the "Bill as" selector defaults to the shipped channel and no banner/reason shows.
- Switch it to "Contract Brewing": the line items rebuild (packaging fees / keg-cleaning / forklift / best-effort excise), the off-model info banner appears, and the reason field is required (submit disabled until filled).
- Switch to a channel that crosses the excise boundary (a wholesale shipment → contract_brewing, or vice-versa) and confirm the red excise banner appears.
- Check `read_console_messages` / `preview_logs` for errors; screenshot the override state.

- [ ] **Step 7: Full verify + commit**

Run: `npm run verify`
Expected: lint + typecheck + tests all pass.

```bash
git add app/production/components/InvoicePreviewModal.tsx
git commit -m "feat(export): bill-as channel override with reason + excise-boundary warning in Generate Invoice modal"
```

---

## Final review

- [ ] Run the mandatory single **Opus whole-branch review** (`superpowers:requesting-code-review`) — do NOT skip under budget pressure (memory: final review catches real bugs). Focus: that no path writes `export_transactions.channel` or calls `checkAndFulfillCommitment`; that the reason requirement is enforced server-side (not only in the modal); and that excise lines are never fabricated when detail rows are absent.

## Self-review against the spec

- **Invoice-time override only** → Tasks 2/5 branch on the override and never write `export_transactions.channel`. ✓
- **Full contract_brewing base, excise best-effort** → `buildInvoicePreview`'s contract_brewing branch is reused unchanged; `buildExciseTaxLines` already returns `[]` when no detail rows exist (verified `exportInvoicePreview.ts:75`). ✓
- **Reason required + shipped/billed recorded** → Task 5 (server-enforced reason, three persisted columns) + Task 6 (modal reason field). ✓ No role restriction (per user). ✓
- **Excise boundary warning** → Task 1 helper + Task 6 red banner. ✓
- **Commitments / reporting untouched** → no task references `commitments`, `commitmentFulfillment`, or ship-time code; migration adds only nullable audit columns. ✓
- **Placeholder scan** → no TBD/TODO; every code step shows concrete content. ✓
- **Type consistency** → `resolveInvoiceChannel` return shape, `InvoicePreviewResult.shippedChannel`, the hook's `shippedChannel` type, and the modal's `data.shippedChannel` all agree; `bill_as_channel`/`override_reason` names match between modal bodies (Task 6) and route `PostBody` (Task 5). ✓
