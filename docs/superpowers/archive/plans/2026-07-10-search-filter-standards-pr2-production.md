# Search / Filter / Sort Standards — PR 2 (Rest of Production) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Retrofit the remaining production search/filter/sort surfaces onto the shared foundation (merged in #139/#154) and migrate `CommitmentsTab` off the legacy `app/reports/components/SortControls.tsx`. Five components; no foundation changes needed (`matches` predicate + `setSort` already exist).

**Architecture:** Each component replaces hand-rolled filter/sort state with `useTableControls` + `app/components/ui/` primitives, deriving rows via `lib/table/applyControls`. One case (MappingDrawer, a transient combobox) uses the pure `applyControls` engine directly with local state — no URL sync — to keep the dropdown UX intact while removing the inline `.includes`.

**Tech Stack:** Next.js 16 App Router, TypeScript, Tailwind v4, React 19, Vitest (node, `lib/**` only), `next/navigation`.

## Global Constraints

- Foundation (already on `main`): `lib/table/{types,applyControls,urlState}.ts`; `app/components/ui/{useTableControls.ts,SearchInput,FilterChips,FilterSelect,FilterBar,SortableTh}.tsx`. `FilterSpec` supports `matches?: (row, selected[]) => boolean` (accessor optional when matches given). `coerce()` handles ISO date strings correctly — **date sort accessors return the raw ISO string** (no `.getTime()`).
- **Config referential stability:** module-scope constant when accessors are pure; `useMemo` (correct deps) when they close over component data (maps).
- **Params:** search `q`, filters keyed by dimension name, sort `sort=key`/`-key`. **Namespace with `prefix` on shared-URL routes:** `/production/export` tabs → ExportInvoices `inv_`, Shipments `ship_` (Export Bay already uses `bay_`). `/production/intake` tabs → Commitments `commit_`. Standalone routes (PackagingVariations, MappingDrawer) need no prefix.
- **Standard rules:** field-coded search (placeholder names the field; different entities → separate controls; identity fields may share a box); ≤5 mutually-exclusive options → `FilterChips`, >5 → `FilterSelect`; "All" = empty array (auto-rendered); lean toward `SortableTh` where a real `<table>` exists.
- **Data-category colors** are the sanctioned raw-color exception — pass via `FilterChips` `options[].className`: channel (`CHANNEL_COLOR`/`CHANNEL_BADGE` — contract_brewing = `CATEGORY_BADGE_CLASS.purple` in Commitments), keg (`KEG_TAG_BADGE`). Never token-swap them.
- **Behavior-preserving:** same rows for the same intent; preserve fixed orderings, load-bearing totals/counts, and grouped/card layouts. Deliberate minor changes are called out per task.
- **Date-range / year selectors:** per the design's non-goals, a date-range picker (Shipments `dateFrom`/`dateTo`) stays a local control — do NOT force it into the categorical model.
- **Suspense:** every `/production/*` route inherits a `<Suspense>` boundary from `app/production/loading.tsx`; MappingDrawer uses `applyControls` locally (no `useSearchParams`) so needs none. Verify `npm run build` after each task anyway.
- **No component unit tests** (vitest is node/`lib`-only). Per-task gate = `tsc --noEmit` + `build` + `lint` + `check:search-filter` (the file's violations disappear) + `test` (engine green). Browser verification is a controller step at the end.
- **Commit trailer:** end every commit body with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

## Out of scope (deferred)
- **PartnersTab** — its search is server-side (Square contacts API) and is **not** guard-flagged; a `SearchInput` reshell would need autofocus + debounce-semantics changes for little gain and risks the combobox UX. Deferred to a later cleanup (note in PR 4).
- `app/reports/components/SortControls.tsx` is deleted in **PR 4** (after this PR removes its last consumer, CommitmentsTab). Do NOT delete it here — other nothing imports it after this PR, but the deletion + guard-flip is PR 4's step.

---

## File Structure

Modified:
- `app/production/components/intake/CommitmentsTab.tsx` (Task 1)
- `app/production/components/ExportInvoicesTab.tsx` (Task 2)
- `app/production/components/PackagingVariationsPanel.tsx` (Task 3)
- `app/production/settings/square-links/MappingDrawer.tsx` (Task 4)
- `app/production/components/ShipmentsTab.tsx` (Task 5)

---

### Task 1: CommitmentsTab — migrate off legacy SortControls → shared primitives

**Files:** Modify `app/production/components/intake/CommitmentsTab.tsx`

**Interfaces:** Consumes `useTableControls`, `FilterChips`, `FilterSelect`, `FilterBar`, `SortableTh`, `ControlsConfig`. Produces nothing downstream.

**Context:** Real `<table>`. Currently `import { useSort, SortTh } from "@/app/reports/components/SortControls"` (line ~15). Filters: `channelFilter`/`filterStyle`/`filterPartner` (all single-value equality). Sort via `useSort(sortableRows)` → `SortTh` headers on 10 columns. `SortableRow` extends `ContractBrewingRequest` with derived `partner_name`, `packaging_total_bbl`, `schedule_sort`, `beer_style`. Route `/production/intake` (sibling subtabs share URL → `prefix: "commit_"`).

- [ ] **Step 1: Add imports + config (module scope)**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import SortableTh from "@/app/components/ui/SortableTh";
import type { ControlsConfig } from "@/lib/table/types";
// REMOVE: import { useSort, SortTh } from "@/app/reports/components/SortControls";

const CHANNEL_OPTIONS = [
  { value: "distribution", label: CHANNEL_META.distribution.label },
  { value: "contract_brewing", label: CHANNEL_META.contract_brewing.label, className: CC.purple },
  { value: "wholesale", label: CHANNEL_META.wholesale.label },
];

const COMMITMENT_CONTROLS: ControlsConfig<SortableRow> = {
  filters: [
    { param: "channel", accessor: (r) => r.channel },
    { param: "style", accessor: (r) => r.beer_style },
    { param: "partner", accessor: (r) => r.partner_id ?? "" },
  ],
  sort: {
    columns: [
      { key: "channel", accessor: (r) => r.channel },
      { key: "status", accessor: (r) => r.status },
      { key: "beer_style", accessor: (r) => r.beer_style },
      { key: "partner_name", accessor: (r) => r.partner_name },
      { key: "volume_bbl", accessor: (r) => r.volume_bbl },
      { key: "packaging_total_bbl", accessor: (r) => r.packaging_total_bbl },
      { key: "schedule_sort", accessor: (r) => r.schedule_sort },
      { key: "received_on", accessor: (r) => r.received_on ?? "" },
      { key: "locked_on", accessor: (r) => r.locked_on ?? "" },
      { key: "last_edited_on", accessor: (r) => r.last_edited_on ?? "" },
    ],
  },
};
```

- [ ] **Step 2: Replace state + filter + sort wiring**

Keep the `sortableRows` derivation but source it from ALL `rows` (not the manually-filtered list — the hook filters). Remove `channelFilter`/`filterStyle`/`filterPartner` state, the manual `filtered` derivation, and the `useSort(...)` call. Replace with:

```tsx
  const sortableRows: SortableRow[] = useMemo(
    () => rows.map((q) => ({
      ...q,
      partner_name: q.contract_brewing_partners?.company_name ?? "",
      packaging_total_bbl: packagingTotalBbl(q),
      schedule_sort: q.cadence === "recurring" ? (q.start_date ?? "") : (q.desired_delivery_date ?? ""),
      beer_style: q.recipes?.beer_name ?? "",
    })),
    [rows],
  );

  const { rows: displayRows, filters, sort, setFilter, toggleSort, reset, activeCount } =
    useTableControls(sortableRows, COMMITMENT_CONTROLS, { prefix: "commit_" });
```

Keep `uniqueStyles` and `uniquePartners` derivations for the filter options.

- [ ] **Step 3: Replace the filter bar JSX**

Replace the channel-chips + style/partner selects + Clear block with:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <FilterChips label="Channel" options={CHANNEL_OPTIONS}
          value={filters.channel ?? []} onChange={(v) => setFilter("channel", v)} />
        <FilterSelect label="Style"
          options={uniqueStyles.map((s) => ({ value: s, label: s }))}
          value={filters.style ?? []} onChange={(v) => setFilter("style", v)} />
        <FilterSelect label="Partner"
          options={uniquePartners.map(([id, name]) => ({ value: id, label: name }))}
          value={filters.partner ?? []} onChange={(v) => setFilter("partner", v)} />
      </FilterBar>
```

(Match the exact shape of `uniquePartners` in the file — it is a `Map`/array of `[id, name]`; adapt the `.map` accordingly. Keep the existing "+ New" button, using its current `.btn-*` class.)

- [ ] **Step 4: Swap the 10 `SortTh` → `SortableTh`**

For each of the 10 sort headers, replace `<SortTh col="X" label="…" sortKey={sortKey} sortDir={sortDir} onSort={handleSort} />` with `<SortableTh sortKey="X" label="…" sort={sort} onSort={toggleSort} />` (same `col`→`sortKey` values from the config; keep labels/alignment). Leave the non-sortable `<th>`s (Invoicing, Notes, actions) unchanged.

- [ ] **Step 5: Gate**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; then `npm run check:search-filter` (CommitmentsTab must not appear; the reports/SortControls warn remains — deleted in PR 4). Commit:

```bash
git add app/production/components/intake/CommitmentsTab.tsx
git commit -m "$(cat <<'EOF'
refactor(production): Commitments off legacy SortControls onto shared primitives

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: ExportInvoicesTab — add SortableTh + URL-synced filters + invoice-# search

**Files:** Modify `app/production/components/ExportInvoicesTab.tsx`

**Interfaces:** Consumes `useTableControls`, `SearchInput`, `FilterSelect`, `FilterBar`, `SortableTh`, `ControlsConfig`. Produces nothing.

**Context:** Real `<table>` (headers: Invoice #, Date, Customer, Status, Total). Flat `ExportInvoiceListItem[]`. Filters `customerFilter`/`statusFilter`/`yearFilter` (all equality). No search/sort today. Route `/production/export` → `prefix: "inv_"`.

- [ ] **Step 1: Config (useMemo — customer sort needs the partner-name map)**

First confirm the invoice-number field name rendered in the "Invoice #" column (read the row JSX; likely `invoice_number`). Use it in search + sort. Build a `partnerNameById` map from `partners`.

```tsx
  const partnerNameById = useMemo(() => new Map(partners.map((p) => [p.id, p.company_name])), [partners]);
  const invoiceControls = useMemo<ControlsConfig<ExportInvoiceListItem>>(() => ({
    search: [{ param: "q", accessor: (i) => i.invoice_number ?? "" }], // ← field-coded to invoice #
    filters: [
      { param: "customer", accessor: (i) => i.partner_id ?? "" },
      { param: "status", accessor: (i) => i.status },
      { param: "year", accessor: (i) => i.invoice_date?.slice(0, 4) ?? "" },
    ],
    sort: {
      columns: [
        { key: "invoice_number", accessor: (i) => i.invoice_number ?? "" },
        { key: "invoice_date", accessor: (i) => i.invoice_date ?? "" },
        { key: "customer", accessor: (i) => partnerNameById.get(i.partner_id ?? "") ?? "" },
        { key: "status", accessor: (i) => i.status },
        { key: "total", accessor: (i) => i.total_cents },
      ],
      default: { key: "invoice_date", dir: "desc" },
    },
  }), [partnerNameById]);
```

- [ ] **Step 2: Drive rows through the hook**

Remove `customerFilter`/`statusFilter`/`yearFilter` state and the manual `filtered` derivation. Replace with:

```tsx
  const { rows: filtered, search, filters, sort, setSearch, setFilter, toggleSort, reset, activeCount } =
    useTableControls(invoices, invoiceControls, { prefix: "inv_" });
```

Keep `openTotal`/`grandTotal`/`filtered.length` — they already read `filtered`.

- [ ] **Step 3: Replace the 3 selects with a FilterBar; make headers sortable**

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search invoice #…" />
        <FilterSelect label="Customer"
          options={partners.map((p) => ({ value: p.id, label: p.company_name }))}
          value={filters.customer ?? []} onChange={(v) => setFilter("customer", v)} />
        <FilterSelect label="Status"
          options={[{value:"draft",label:"Draft"},{value:"open",label:"Sent / Open"},{value:"paid",label:"Paid"},{value:"voided",label:"Voided"}]}
          value={filters.status ?? []} onChange={(v) => setFilter("status", v)} />
        <FilterSelect label="Year"
          options={years.map((y) => ({ value: y, label: y }))}
          value={filters.year ?? []} onChange={(v) => setFilter("year", v)} />
      </FilterBar>
```

In `<thead>`, replace the 5 plain `<th>`s (Invoice #, Date, Customer, Status, Total) with `<SortableTh sortKey="invoice_number|invoice_date|customer|status|total" label="…" sort={sort} onSort={toggleSort} align={…} />`; keep the expand-icon `<th>` non-sortable.

- [ ] **Step 4: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; `npm run check:search-filter` (no new violations). Commit `refactor(production): Export Invoices onto shared primitives (sortable + filters + search)`.

---

### Task 3: PackagingVariationsPanel — search + predicate filters, keep fixed sort + showInactive

**Files:** Modify `app/production/components/PackagingVariationsPanel.tsx`

**Interfaces:** Consumes `useTableControls`, `SearchInput`, `FilterChips`, `FilterBar`, `ControlsConfig`. Produces nothing.

**Context:** Real `<table>`; flat list with a HARDCODED 3-level sort (keg-first → format order → name). Search `search` (name, `.includes`). Local `Chips` filters: type (`container.type`, equality), format (keg→"loose" coercion), partner (`"generic"` sentinel = null). `showInactive` toggle. Route `/production/recipes/variations` (standalone, no prefix). `KEG_TAG_BADGE` for the keg pill.

- [ ] **Step 1: Config (module scope) + keg-colored type option**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import SearchInput from "@/app/components/ui/SearchInput";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

const PKGVAR_CONTROLS: ControlsConfig<PackagingVariation> = {
  search: [{ param: "q", accessor: (v) => v.name }],
  filters: [
    { param: "type", accessor: (v) => v.container?.type ?? "" },
    { param: "format", matches: (v, sel) => sel.includes(v.container?.type === "keg" ? "loose" : v.format) },
    { param: "partner", matches: (v, sel) => sel.some((s) => (s === "generic" ? v.partner_id === null : v.partner_id === s)) },
  ],
};

const TYPE_OPTIONS = [
  { value: "keg", label: "Keg", className: KEG_TAG_BADGE },
  { value: "can", label: "Can" },
];
const FORMAT_OPTIONS = FORMATS.map((f) => ({ value: f.value, label: f.label })); // match the FORMATS shape in-file
```

- [ ] **Step 2: Wire hook (showInactive pre-filters input; fixed sort applied after)**

Remove `search`/`filterType`/`filterFormat`/`filterPartner` state and the `displayed` useMemo's filter portion. Keep `showInactive` local. Replace with:

```tsx
  const base = useMemo(
    () => (showInactive ? variations : variations.filter((v) => v.is_active)),
    [variations, showInactive],
  );
  const { rows: matched, search, filters, setSearch, setFilter, reset, activeCount } =
    useTableControls(base, PKGVAR_CONTROLS);

  // preserve the existing hardcoded keg-first → format-order → name ordering
  const displayed = useMemo(() => {
    return [...matched].sort((a, b) => {
      const ta = a.container?.type === "keg" ? 0 : 1;
      const tb = b.container?.type === "keg" ? 0 : 1;
      if (ta !== tb) return ta - tb;
      const fa = FORMAT_ORDER.indexOf(a.container?.type === "keg" ? "loose" : a.format);
      const fb = FORMAT_ORDER.indexOf(b.container?.type === "keg" ? "loose" : b.format);
      if (fa !== fb) return fa - fb;
      return a.name.localeCompare(b.name);
    });
  }, [matched]);
```

(Partner options `partnerChipOptions` keep their derivation but reshape to `{value,label}` incl. the `generic`/`all` entries — the shared `FilterChips` auto-adds the "All" chip, so DROP the explicit `all` entry.)

**Accepted minor change:** the old side-effect that reset `format` to "all" when `type=keg` was chosen is dropped; a keg + specific-format selection now simply shows no rows (keg's effective format is "loose"). Document it; don't reimplement.

- [ ] **Step 3: Replace the search box + `Chips` with FilterBar**

Delete the local `Chips` component if now unused. Render:

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <SearchInput value={search.q ?? ""} onChange={(v) => setSearch("q", v)} placeholder="Search variations…" />
        <FilterChips label="Type" options={TYPE_OPTIONS} value={filters.type ?? []} onChange={(v) => setFilter("type", v)} />
        <FilterChips label="Format" options={FORMAT_OPTIONS} value={filters.format ?? []} onChange={(v) => setFilter("format", v)} />
        {partnerChipOptions.length > 0 && (
          <FilterChips label="Partner" options={partnerChipOptions} value={filters.partner ?? []} onChange={(v) => setFilter("partner", v)} />
        )}
      </FilterBar>
```

Keep the `showInactive` checkbox and the "N of M variations" count (now off `displayed`/`variations`).

- [ ] **Step 4: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; `npm run check:search-filter` (PackagingVariationsPanel's `type="search"` + `.includes` GONE). Commit `refactor(production): Packaging Variations onto shared primitives`.

---

### Task 4: MappingDrawer — swap inline `.includes` for shared `applyControls` (no URL sync)

**Files:** Modify `app/production/settings/square-links/MappingDrawer.tsx`

**Interfaces:** Consumes `applyControls`, `ControlsConfig`. Produces nothing.

**Context:** The inner `VariationCombobox` is a custom autocomplete (open-on-focus, outside-click close). Its filter (line ~37-41) is an inline blended `.toLowerCase().includes()` over `` `${v.item_name} ${v.variation_name}` `` — item_name + variation_name are the SAME entity's identity fields (identity-blend OK). This is a transient drawer combobox — do NOT URL-sync it and do NOT reshape the combobox UX. Only replace the inline filter with the shared engine to remove the guard-flagged `.includes` and centralize the match logic.

- [ ] **Step 1: Replace the inline filter**

```tsx
import { applyControls } from "@/lib/table/applyControls";
import type { ControlsConfig } from "@/lib/table/types";

const COMBOBOX_CONTROLS: ControlsConfig<SquareVariation> = {
  search: [{ param: "q", accessor: (v) => [v.item_name, v.variation_name] }],
};
```

Replace the current `const filtered = query ? variations.filter((v) => `${v.item_name} ${v.variation_name ?? ""}`.toLowerCase().includes(query.toLowerCase())) : variations;` with:

```tsx
  const filtered = applyControls(variations, COMBOBOX_CONTROLS, { search: { q: query }, filters: {}, sort: null });
```

Keep the local `query`/`open` state, the `<input>`, the dropdown, and all combobox behavior exactly as-is. (Do NOT swap the input for `SearchInput` — the combobox needs its own focus/blur handling.)

- [ ] **Step 2: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; `npm run check:search-filter` (MappingDrawer's `.includes` GONE). Commit `refactor(production): Mapping Drawer combobox filter via shared applyControls`.

---

### Task 5: ShipmentsTab — URL-synced categorical filters (card grid, keep date range)

**Files:** Modify `app/production/components/ShipmentsTab.tsx`

**Interfaces:** Consumes `useTableControls`, `FilterChips`, `FilterSelect`, `FilterBar`, `ControlsConfig`. Produces nothing.

**Context:** CSS-grid CARD list (NOT a `<table>`) → no `SortableTh`, no sort. Renders `InvoiceGroup[]`. Filters: `channelFilter` (group predicate `.some` over products), `statusFilter` (equality on group), `customerFilter` (equality on `recipient_id`), `dateFrom`/`dateTo` (range predicate over products). Route `/production/export` → `prefix: "ship_"`. `CHANNEL_BADGE` colors per channel.

- [ ] **Step 1: Config (module scope) + colored channel option**

```tsx
import { useTableControls } from "@/app/components/ui/useTableControls";
import FilterChips from "@/app/components/ui/FilterChips";
import FilterSelect from "@/app/components/ui/FilterSelect";
import FilterBar from "@/app/components/ui/FilterBar";
import type { ControlsConfig } from "@/lib/table/types";

const CHANNEL_OPTIONS = (["taproom","distribution","contract_brewing","wholesale"] as const).map((c) => ({
  value: c, label: CHANNEL_LABELS[c], className: CHANNEL_BADGE[c],
}));
const STATUS_OPTIONS = [
  { value: "invoice_required", label: "Invoice Required" },
  { value: "draft", label: "Invoice Drafted" },
  { value: "unpaid", label: "Unpaid" },
  { value: "paid", label: "Paid" },
];

const SHIPMENT_CONTROLS: ControlsConfig<InvoiceGroup> = {
  filters: [
    { param: "channel", matches: (g, sel) => g.products.some((p) => sel.includes(p.channel)) },
    { param: "status", accessor: (g) => g.status },
    { param: "customer", accessor: (g) => g.recipient_id ?? "" },
  ],
};
```

- [ ] **Step 2: Wire hook; keep date range local (applied after)**

Remove `channelFilter`/`statusFilter`/`customerFilter` state (keep `dateFrom`/`dateTo`). Replace the manual `filtered` derivation with:

```tsx
  const { rows: hookFiltered, filters, setFilter, reset, activeCount } =
    useTableControls(invoiceGroups, SHIPMENT_CONTROLS, { prefix: "ship_" });

  const filtered = useMemo(() => hookFiltered.filter((g) => {
    if (dateFrom && !g.products.some((p) => p.created_at.slice(0, 10) >= dateFrom)) return false;
    if (dateTo && !g.products.some((p) => p.created_at.slice(0, 10) <= dateTo)) return false;
    return true;
  }), [hookFiltered, dateFrom, dateTo]);
```

Keep `summaryStats`/`filtered.length` reading `filtered`.

- [ ] **Step 3: Replace the filter bar (keep the two date inputs)**

```tsx
      <FilterBar activeCount={activeCount} onClear={reset}>
        <FilterChips label="Channel" options={CHANNEL_OPTIONS}
          value={filters.channel ?? []} onChange={(v) => setFilter("channel", v)} />
        <FilterSelect label="Status" options={STATUS_OPTIONS}
          value={filters.status ?? []} onChange={(v) => setFilter("status", v)} />
        <FilterSelect label="Customer"
          options={invoiceablePartners.map((p) => ({ value: p.id, label: p.name }))}
          value={filters.customer ?? []} onChange={(v) => setFilter("customer", v)} />
        {/* date range stays a local control (design non-goal: date-range selectors unchanged) */}
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">From
          <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="inp-sm w-auto" /></label>
        <label className="inline-flex items-center gap-1.5 text-xs text-muted">To
          <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="inp-sm w-auto" /></label>
      </FilterBar>
```

(Match `invoiceablePartners`'s actual shape for the customer options. `FilterBar`'s "Clear (N)" resets only the hook filters; the date inputs clear independently — keep any existing date-clear affordance, or add `setDateFrom("")`/`setDateTo("")` to a combined clear if the file had one.)

- [ ] **Step 4: Gate + commit**

`npx tsc --noEmit && npm run build && npm run lint && npm run test`; `npm run check:search-filter` (no new violations). Commit `refactor(production): Shipments filters onto shared primitives (URL-synced)`.

---

## Definition of Done (PR 2)

- [ ] `npm run test` passes; `npx tsc --noEmit` clean; `npm run lint` 0 errors; `npm run build` succeeds (all routes).
- [ ] `npm run check:search-filter`: CommitmentsTab, PackagingVariationsPanel, MappingDrawer cleared. Remaining warns = the 2 API-route false-positives + `app/reports/components/SortControls.tsx` (PR 4). Record before/after.
- [ ] `app/reports/components/SortControls.tsx` has **no remaining importers** (CommitmentsTab was its last one) — verify with a grep; the file is deleted in PR 4.
- [ ] **Browser verification (controller):** on the Vercel preview / dev, exercise each surface — Commitments sort columns + filters, Export Invoices sort + search + filters, Packaging Variations search + chip filters (keg/format/partner) with the fixed ordering intact, Mapping Drawer combobox still searches item+variation, Shipments channel/status/customer filters + date range + summary totals. Confirm URL updates and reload restores state (prefixed params don't collide across the export/intake sibling tabs).

## Out of scope (later PRs)
- PR 3: finance (transactions, statements, account-mapping/AccountSelect, MappingFilter/YearSelect adoption).
- PR 4: taproom remainder + **delete `app/reports/components/SortControls.tsx`** + PartnersTab reshell + flip guard to `--strict` (first refine the guard's `.toLowerCase().includes(` rule — it false-positives on `app/api/finance/sales/events/route.ts` and `app/api/taproom/events/[id]/pours/route.ts`).
