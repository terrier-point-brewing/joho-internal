# Spec 11: Export Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Packaging Fee Settings UI fragmentation bug (it lists every `packaging_items` row, including non-shippable components, instead of just the 5 canonical containers) and make invoice generation fail loudly instead of silently under-billing when a shipped container has no Packaging Fee mapping configured.

**Architecture:** Two independent, narrowly-scoped changes to existing files — no new files, no schema/migration. (1) `app/production/components/ExportSettingsPanel.tsx`'s `PackagingFeeSection` filters its packaging-items list to containers only before rendering default mapping rows. (2) `lib/production/exportInvoicePreview.ts`'s packaging-fee line-item loop throws a descriptive error instead of silently skipping when no mapping is found for a transaction's container.

**Tech Stack:** Next.js 16 App Router, TypeScript, React Query, Supabase Postgres (no schema change in this spec).

## Global Constraints

- No test runner exists in this repo. Verification is `npm run lint` (must show 0 errors) + `npm run build` (must succeed) + direct code review, per Roadmap Lesson #1 and #9 (Spec 9's session: `npm run build` alone does not catch ESLint errors under Turbopack — always run `npm run lint` explicitly).
- No DB migration in this spec — confirmed via live query against `drlsazatrcrdwaihjmex` that zero `export_service_mappings` rows of `service_type = 'packaging_fee'` exist yet, so there is no data to backfill.
- `export_service_mappings.packaging_item_id` is NOT renamed — see spec's "Decision: no schema change" section.

---

### Task 1: Filter Packaging Fee Settings UI to containers only

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx:206-285` (the `PackagingFeeSection` function)

**Interfaces:**
- Consumes: `usePackagingQuery()` (from `app/production/hooks/queries.ts:125-130`), which returns `PackagingItem[]` where `PackagingItem.type` is one of `'keg' | 'can' | 'lid' | 'paktech' | 'tray' | 'label'` (defined in `app/production/types.ts:32-40`, `PackagingItemType`).
- Produces: nothing consumed by later tasks — this is a self-contained UI fix.

This task has no automated test (no test runner in this repo, per Global Constraints). Verification is a manual check in the running app after the change, described in the final step.

- [ ] **Step 1: Read the current `PackagingFeeSection` function**

Open `app/production/components/ExportSettingsPanel.tsx` and confirm lines 206-285 still match this (current as of this plan being written):

```tsx
function PackagingFeeSection() {
  const { data: mappings = [] } = useExportServiceMappingsQuery();
  const { data: partners = [] } = useContractPartnersQuery();
  const { data: packagingItems = [] } = usePackagingQuery();
  const { data: catalog } = useExportSquareCatalogQuery();
  const qc = useQueryClient();
  const items = catalog?.items ?? [];

  const feeRows = mappings.filter((m) => m.service_type === "packaging_fee");

  async function upsert(existing: ExportServiceMapping | null, patch: Partial<ExportServiceMapping> & { packaging_item_id: string; partner_id: string | null }) {
    await fetch("/api/production/export-settings/service-mappings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: existing?.id,
        service_type: "packaging_fee",
        partner_id: patch.partner_id,
        packaging_item_id: patch.packaging_item_id,
        display_name: existing?.display_name ?? "Packaging Fee",
        square_catalog_item_id: patch.square_catalog_item_id ?? existing?.square_catalog_item_id ?? null,
        square_catalog_variation_id: patch.square_catalog_variation_id ?? existing?.square_catalog_variation_id ?? null,
      }),
    });
    await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
  }

  return (
    <section>
      <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-2">Packaging Fee</h4>
      <p className="text-xs text-zinc-600 mb-2">Default mapping per packaging item, with optional per-partner overrides.</p>
      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50 text-left">
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Partner</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Packaging</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500">Square Mapping</th>
              <th className="px-4 py-2.5 text-xs font-medium text-zinc-500" />
            </tr>
          </thead>
          <tbody>
            {packagingItems.map((pkg) => {
              const defaultRow = feeRows.find((m) => m.packaging_item_id === pkg.id && m.partner_id === null);
              return (
                <tr key={pkg.id} className="border-b border-zinc-800 last:border-0">
                  <td className="px-4 py-2.5 text-zinc-500 italic">Default</td>
                  <td className="px-4 py-2.5 text-zinc-300">{pkg.name}</td>
                  <td className="px-4 py-2.5">
                    <SquareCatalogSelect
                      items={items}
                      itemId={defaultRow?.square_catalog_item_id ?? null}
                      variationId={defaultRow?.square_catalog_variation_id ?? null}
                      onChange={(itemId, variationId) =>
                        upsert(defaultRow ?? null, { partner_id: null, packaging_item_id: pkg.id, square_catalog_item_id: itemId, square_catalog_variation_id: variationId })
                      }
                    />
                  </td>
                  <td />
                </tr>
              );
            })}
            {feeRows.filter((m) => m.partner_id !== null).map((m) => {
              const partner = partners.find((p) => p.id === m.partner_id);
              return (
                <ServiceMappingRow
                  key={m.id}
                  mapping={m}
                  items={items}
                  partnerLabel={partner?.company_name ?? "Unknown partner"}
                  onSave={(existing, patch) => upsert(existing, { ...patch, partner_id: existing.partner_id, packaging_item_id: existing.packaging_item_id! })}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

If the lines have drifted from this (e.g. another spec touched this file first), stop and re-read the live file fully before proceeding — do not blindly apply the diff below onto different surrounding code.

- [ ] **Step 2: Add the container filter and use it in the default-rows map**

Add one line right after the `usePackagingQuery()` destructure, and change the `.map()` call to use the filtered list instead of the raw list. The diff is two changes within the function body:

```diff
   const { data: packagingItems = [] } = usePackagingQuery();
   const { data: catalog } = useExportSquareCatalogQuery();
   const qc = useQueryClient();
   const items = catalog?.items ?? [];
+
+  // Packaging Fee is charged per shippable container, not per assembly
+  // component (lid/paktech/tray/label) — see Spec 11 design doc.
+  const containerItems = packagingItems.filter((p) => p.type === "keg" || p.type === "can");
```

```diff
           <tbody>
-            {packagingItems.map((pkg) => {
+            {containerItems.map((pkg) => {
               const defaultRow = feeRows.find((m) => m.packaging_item_id === pkg.id && m.partner_id === null);
```

The full function after this change should read exactly as in Step 1, with those two diffs applied (the `// Packaging Fee...` comment block inserted after the `items` line, and `packagingItems.map` replaced with `containerItems.map`).

- [ ] **Step 3: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.

```bash
npm run build
```
Expected: build succeeds with no type errors.

- [ ] **Step 4: Manual verification in the running app**

Start the dev server if not already running:
```bash
npm run dev
```

Navigate to Production → Settings → Export Settings (or wherever `ExportSettingsPanel` with `scope="full"` is mounted — confirm via `grep -rn "ExportSettingsPanel" app/production` if the route isn't immediately obvious). Confirm the Packaging Fee table shows exactly 5 rows under "Default" (1/2 Keg, 1/4 Keg, 1/6 Keg, 12oz Blank, 16oz Blank) and no rows for any lid/PakTech/tray/label item. Take a screenshot or describe what you see if asked to report back.

- [ ] **Step 5: Commit**

```bash
git add app/production/components/ExportSettingsPanel.tsx
git commit -m "fix: scope Packaging Fee settings to containers only

PackagingFeeSection listed every packaging_items row (containers and
assembly components alike) as a fee-mappable unit. Filter to
type in ('keg','can') only, mirroring the existing container-filter
precedent in PackagingVariationsPanel.tsx."
```

---

### Task 2: Fail loudly when a shipped container has no Packaging Fee mapping

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts:81-128`

**Interfaces:**
- Consumes: nothing from Task 1 — fully independent change to a different file.
- Produces: `buildInvoicePreview()` (exported, used by `app/api/production/export/invoice/route.ts`) now throws `Error` with a descriptive message when a transaction's container has no usable Packaging Fee mapping, instead of silently omitting that line item. No signature change — same exported function name, same parameters, same return type (`Promise<InvoicePreviewResult>`). Callers that already wrap this in try/catch and surface the error message as an API error response need no change.

This task has no automated test (no test runner in this repo). Verification is lint + build + a direct read-through confirming the thrown error is reachable and well-formed, plus (optionally, if the user wants to exercise it) a manual API check described in Step 4.

- [ ] **Step 1: Read the current packaging-items query and packaging-fee loop**

Confirm `lib/production/exportInvoicePreview.ts` lines 81-128 still read exactly as follows (current as of this plan being written):

```ts
  // ── 3. Load packaging items (for type='keg' detection) ────────────────────
  const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];
  const { data: pkgItems } = await supabase
    .from("packaging_items")
    .select("id, type")
    .in("id", packagingItemIds);
  const pkgTypeById = new Map((pkgItems ?? []).map((p) => [p.id, p.type as string]));

  // ── 4. Load service mappings for this partner (with default fallback) ────
  const { data: mappings } = await supabase
    .from("export_service_mappings")
    .select("service_type, partner_id, packaging_item_id, square_catalog_item_id, square_catalog_variation_id, square_catalog_discount_id, display_name")
    .or(`partner_id.eq.${customerId},partner_id.is.null`);

  function findMapping(serviceType: string, packagingItemId: string | null) {
    const rows2 = mappings ?? [];
    const partnerRow = rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === customerId && m.packaging_item_id === packagingItemId
    );
    if (partnerRow) return partnerRow;
    return rows2.find(
      (m) => m.service_type === serviceType && m.partner_id === null && m.packaging_item_id === packagingItemId
    );
  }

  // ── 5. Resolve Square catalog prices for whatever variation IDs we need ──
  const catalogItems = await fetchCatalogItems();
  const priceByVariationId = buildStandalonePriceMap(catalogItems);

  const lineItems: InvoiceLineItemDraft[] = [];

  // ── 5a. Packaging Fee — one line per transaction ──────────────────────────
  const kegFeeTransactionIds = new Set<string>();
  for (const tx of rows) {
    const mapping = findMapping("packaging_fee", tx.packaging_item_id);
    if (!mapping?.square_catalog_variation_id) continue;
    const unitPriceCents = priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0;
    const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
    if (isKeg) kegFeeTransactionIds.add(tx.id);
    lineItems.push({
      id: crypto.randomUUID(),
      description: mapping.display_name,
      quantity: tx.quantity,
      unitPriceCents,
      squareCatalogVariationId: mapping.square_catalog_variation_id,
      discountCatalogId: isKeg ? findMapping("bulk_discount", null)?.square_catalog_discount_id ?? null : null,
    });
  }
```

If these lines have drifted, stop and re-read the live file fully before proceeding.

- [ ] **Step 2: Add a name lookup and throw on missing mapping**

Change the packaging-items query to also select `name`, build a second lookup map for it, and replace the `continue` with a thrown `Error`:

```diff
   // ── 3. Load packaging items (for type='keg' detection) ────────────────────
   const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];
   const { data: pkgItems } = await supabase
     .from("packaging_items")
-    .select("id, type")
+    .select("id, type, name")
     .in("id", packagingItemIds);
   const pkgTypeById = new Map((pkgItems ?? []).map((p) => [p.id, p.type as string]));
+  const pkgNameById = new Map((pkgItems ?? []).map((p) => [p.id, p.name as string]));
```

```diff
   for (const tx of rows) {
     const mapping = findMapping("packaging_fee", tx.packaging_item_id);
-    if (!mapping?.square_catalog_variation_id) continue;
+    if (!mapping?.square_catalog_variation_id) {
+      const containerName = pkgNameById.get(tx.packaging_item_id) ?? "unknown container";
+      throw new Error(
+        `Packaging Fee is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
+      );
+    }
     const unitPriceCents = priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0;
```

- [ ] **Step 3: Run lint and build**

```bash
npm run lint
```
Expected: 0 errors, 0 warnings.

```bash
npm run build
```
Expected: build succeeds with no type errors.

- [ ] **Step 4: Verify the error surfaces correctly (read-through + optional live check)**

Read `app/api/production/export/invoice/route.ts`'s `generate` action handler and confirm it already wraps its call to `buildInvoicePreview` in a try/catch that returns the caught error's `.message` as a JSON error response (this was true as of Spec 6 — re-confirm against the live file, do not assume). If it does, no route change is needed — the new thrown error will surface as a normal API error response with the descriptive message, same as any other validation error in that route already does.

If the user wants to exercise this live: pick or create an `invoice_required` export transaction whose container has no Packaging Fee mapping configured (true for all 5 containers right now, since zero mappings exist in the live DB), call the `generate` invoice action against it via the UI or a direct API request, and confirm the response is the descriptive error message rather than a silently-incomplete invoice draft. This is optional — do not perform a live Square action without the user's explicit fresh opt-in, per Roadmap Lesson #9.

- [ ] **Step 5: Commit**

```bash
git add lib/production/exportInvoicePreview.ts
git commit -m "fix: throw instead of silently skipping unconfigured Packaging Fee

A shipped container with no Packaging Fee mapping configured was
silently producing an invoice with that line item missing entirely —
no error, just a lower total than expected. Throw a descriptive error
naming the container instead, matching this project's established
fail-loudly convention for missing required configuration."
```

---

## Self-Review

**1. Spec coverage:**
- Spec's "Decision: no schema change" — no task introduces a migration. Covered (by omission, correctly).
- Spec change 1 (`PackagingFeeSection` container filter) — Task 1.
- Spec change 2 (fail loudly in `exportInvoicePreview.ts`) — Task 2.
- Spec's "Out of scope" items (5.1, 5.2, ExportBayTab variant_label, packaging_variations consumption) — correctly has no task; nothing in this plan touches those files.
- Spec's testing section (lint + build + manual UI check) — present in both tasks' verification steps.

**2. Placeholder scan:** No TBD/TODO markers. All diffs show complete before/after code, not prose descriptions.

**3. Type consistency:** Task 2's `pkgNameById` follows the exact same `Map<string, string>` construction pattern as the existing `pkgTypeById` one line above it — same `.select()` call extended, same `.map()` shape. No new types introduced; `buildInvoicePreview`'s exported signature is unchanged (still throws via the existing `Error` type already used elsewhere in this same function, e.g. line 40/50/56/69 of the current file).

No gaps found.
