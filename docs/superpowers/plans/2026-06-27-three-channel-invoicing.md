# Three-Channel Invoicing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `wholesale` as a third commitment/export channel and branch export invoice line-item building by channel so contract_brewing, distribution, and wholesale each produce the correct invoice automatically.

**Architecture:** One DB migration extends four channel constraints and adds a `packaging_format` column to `recipe_square_links`. TypeScript types are updated first as they gate all downstream work. Tasks 2–5 are independent of each other and can run in parallel subagents once Tasks 0–1 land.

**Tech Stack:** Next.js 16 App Router, TypeScript, Supabase Postgres (migrations via SQL files), React, TanStack Query v5, Square API (raw fetch)

## Global Constraints

- No business logic in `app/api/**` — extract to `lib/` if needed
- Use `createSupabaseServerClient()` in route handlers, never the browser client
- `supabase/migrations/` is the schema source of truth — never hand-edit existing migration files; add a new one
- Build verification command: `npm run build` — must produce zero TS errors and zero lint errors
- `lib/auth.ts` `requireRole()` must wrap every mutating route handler — do not roll your own auth
- Square API version `2025-04-16`; location `LZ8TH4A632YW0`

---

## Task 0: DB Migration

**Files:**
- Create: `supabase/migrations/20260627_three_channel_invoicing.sql`

**Interfaces:**
- Produces: DB schema with `wholesale` in all channel columns; `distribution_discount`/`wholesale_discount` in `invoice_item_mappings.service_type`; `packaging_format` column on `recipe_square_links`

- [ ] **Step 1: Check existing channel constraints**

  Run against the Supabase project (or inspect the latest migrations) to understand the current CHECK constraint names:

  ```bash
  grep -r "channel.*check\|batch_allocations\|commitments.*channel\|export_transactions.*channel" supabase/migrations/ | grep -v "^Binary"
  ```

  The constraint names matter — the migration must `DROP CONSTRAINT` by exact name before re-adding.

  From the migration history (`20260629_invoice_item_mappings.sql`), the `invoice_item_mappings` constraint is named `invoice_item_mappings_service_type_check` and `invoice_item_mappings_check`. Verify constraint names for the other three tables by running:

  ```bash
  grep -r "channel" supabase/migrations/ | grep "constraint\|CHECK" | head -20
  ```

- [ ] **Step 2: Write the migration file**

  Create `supabase/migrations/20260627_three_channel_invoicing.sql`:

  ```sql
  -- supabase/migrations/20260627_three_channel_invoicing.sql
  -- Spec 9: Three-channel invoicing — add wholesale channel throughout,
  -- add distribution_discount/wholesale_discount service types,
  -- add packaging_format dimension to recipe_square_links for can format mappings.

  -- 1. commitments.channel — add 'wholesale'
  alter table public.commitments
    drop constraint if exists commitments_channel_check;
  alter table public.commitments
    add constraint commitments_channel_check
    check (channel in ('distribution', 'contract_brewing', 'wholesale'));

  -- 2. batch_allocations.channel — add 'wholesale'
  alter table public.batch_allocations
    drop constraint if exists batch_allocations_channel_check;
  alter table public.batch_allocations
    add constraint batch_allocations_channel_check
    check (channel in ('taproom', 'distribution', 'contract_brewing', 'wholesale', 'safety_stock'));

  -- 3. export_transactions.channel — add 'wholesale'
  alter table public.export_transactions
    drop constraint if exists export_transactions_channel_check;
  alter table public.export_transactions
    add constraint export_transactions_channel_check
    check (channel in ('taproom', 'distribution', 'contract_brewing', 'wholesale'));

  -- 4. invoice_item_mappings.service_type — add distribution_discount, wholesale_discount
  alter table public.invoice_item_mappings
    drop constraint if exists invoice_item_mappings_service_type_check;
  alter table public.invoice_item_mappings
    add constraint invoice_item_mappings_service_type_check
    check (service_type in (
      'packaging_fee', 'keg_cleaning', 'forklift',
      'bulk_discount', 'ingredient_deposit',
      'distribution_discount', 'wholesale_discount'
    ));

  -- Also extend the cross-column shape check to cover new discount types
  -- (they follow the same shape as bulk_discount: only discount_id populated)
  alter table public.invoice_item_mappings
    drop constraint if exists invoice_item_mappings_check;
  alter table public.invoice_item_mappings
    add constraint invoice_item_mappings_check
    check (
      (service_type = 'packaging_fee' and packaging_item_id is not null
         and square_catalog_item_id is not null and square_catalog_variation_id is not null
         and square_catalog_discount_id is null)
      or
      (service_type in ('keg_cleaning', 'forklift') and packaging_item_id is null
         and square_catalog_item_id is not null and square_catalog_variation_id is not null
         and square_catalog_discount_id is null)
      or
      (service_type in ('bulk_discount', 'distribution_discount', 'wholesale_discount')
         and packaging_item_id is null
         and square_catalog_item_id is null and square_catalog_variation_id is null
         and square_catalog_discount_id is not null)
      or
      (service_type = 'ingredient_deposit' and packaging_item_id is null
         and square_catalog_item_id is not null and square_catalog_variation_id is not null
         and square_catalog_discount_id is null)
    );

  -- 5. recipe_square_links — add packaging_format for can format dimension
  alter table public.recipe_square_links
    add column if not exists packaging_format text
    check (packaging_format in ('loose', '4-pack', '6-pack', 'case'));

  -- 6. Drop old can-link partial unique index (if it exists under any name)
  drop index if exists recipe_square_links_recipe_packaging_item_unique;
  drop index if exists rsl_item_uniq;

  -- 7. Two new partial unique indexes
  -- Kegs: format NULL, uniqueness is recipe + container
  create unique index if not exists rsl_keg_uniq
    on public.recipe_square_links (recipe_id, packaging_item_id)
    where packaging_item_id is not null and packaging_format is null;

  -- Cans: uniqueness is recipe + container + format
  create unique index if not exists rsl_can_format_uniq
    on public.recipe_square_links (recipe_id, packaging_item_id, packaging_format)
    where packaging_item_id is not null and packaging_format is not null;
  ```

  > **Note on constraint names:** If `npm run build` or the Supabase migration apply fails because a constraint name doesn't match, run `select conname from pg_constraint where conrelid = 'public.commitments'::regclass;` (substituting the table name) to find the actual name, then update the `drop constraint` line accordingly.

- [ ] **Step 3: Apply the migration**

  ```bash
  npx supabase db push --db-url "$SUPABASE_DB_URL"
  ```

  If running locally: `npx supabase migration up`

  Expected: Migration applies with no errors. All four tables accept `wholesale`/new discount values.

- [ ] **Step 4: Verify**

  Spot-check via Supabase SQL editor or CLI:

  ```sql
  -- Should succeed:
  select 'distribution_discount' in (
    select unnest(enum_range(null::text))
  );
  -- Simpler: just check the constraint exists
  select conname, consrc from pg_constraint
  where conrelid = 'public.invoice_item_mappings'::regclass
    and contype = 'c';
  ```

  Confirm `packaging_format` column exists on `recipe_square_links`.

- [ ] **Step 5: Commit**

  ```bash
  git add supabase/migrations/20260627_three_channel_invoicing.sql
  git commit -m "feat: migration — wholesale channel + recipe_square_links packaging_format"
  ```

---

## Task 1: TypeScript Types

**Files:**
- Modify: `app/production/types.ts`

**Interfaces:**
- Consumes: Task 0 (DB now accepts these values)
- Produces:
  - `CommitmentChannel = "distribution" | "contract_brewing" | "wholesale"`
  - `ExportChannel = "taproom" | "distribution" | "contract_brewing" | "wholesale"`
  - `AllocationChannel = "taproom" | "distribution" | "contract_brewing" | "wholesale" | "safety_stock"`
  - `ServiceType` union extended with `"distribution_discount" | "wholesale_discount"`
  - `RecipeSquareLink` interface gains `packaging_format: string | null`

- [ ] **Step 1: Update `CommitmentChannel`**

  In `app/production/types.ts` line 295, change:
  ```ts
  // before
  export type CommitmentChannel = "distribution" | "contract_brewing";
  // after
  export type CommitmentChannel = "distribution" | "contract_brewing" | "wholesale";
  ```

- [ ] **Step 2: Update `ExportChannel`**

  Line 157:
  ```ts
  // before
  export type ExportChannel = "taproom" | "distribution" | "contract_brewing";
  // after
  export type ExportChannel = "taproom" | "distribution" | "contract_brewing" | "wholesale";
  ```

- [ ] **Step 3: Update `AllocationChannel`**

  Line 370:
  ```ts
  // before
  export type AllocationChannel = "taproom" | "distribution" | "contract_brewing" | "safety_stock";
  // after
  export type AllocationChannel = "taproom" | "distribution" | "contract_brewing" | "wholesale" | "safety_stock";
  ```

- [ ] **Step 4: Update `ServiceType`**

  Line 539:
  ```ts
  // before
  export type ServiceType = "packaging_fee" | "keg_cleaning" | "forklift" | "bulk_discount" | "ingredient_deposit";
  // after
  export type ServiceType = "packaging_fee" | "keg_cleaning" | "forklift" | "bulk_discount" | "ingredient_deposit" | "distribution_discount" | "wholesale_discount";
  ```

- [ ] **Step 5: Update `RecipeSquareLink`**

  Around line 281. Current interface:
  ```ts
  export interface RecipeSquareLink {
    id: string;
    recipe_id: string;
    packaging: Packaging;
    square_variation_id: string;
    square_item_id: string | null;
    created_at: string;
  }
  ```

  Replace with:
  ```ts
  export interface RecipeSquareLink {
    id: string;
    recipe_id: string;
    packaging: Packaging;
    packaging_item_id: string | null;
    packaging_format: string | null;
    square_variation_id: string;
    square_item_id: string | null;
    created_at: string;
  }
  ```

  Note: `packaging_item_id` was missing from the interface even though the column exists — add it now since Task 3 needs it.

- [ ] **Step 6: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero TypeScript errors related to the type changes. There will be errors in files that use `CHANNEL_COLOR`/`CHANNEL_META` because the maps aren't exhaustive for `wholesale` yet — those are fixed in Tasks 4 and 5. Note them but don't fix them here.

- [ ] **Step 7: Commit**

  ```bash
  git add app/production/types.ts
  git commit -m "feat: add wholesale channel + new discount service types to TypeScript types"
  ```

---

## Task 2: recipe_square_links API + LinkRow Type

**Files:**
- Modify: `app/api/production/recipe-square-links/route.ts`
- Modify: `app/production/components/SquareLinkManager.tsx` (only the `LinkRow` interface and `linkedCombos` key — full UI work is Task 3)

**Interfaces:**
- Consumes: Task 0 (DB has `packaging_format` column), Task 1 (`RecipeSquareLink` has `packaging_format`)
- Produces:
  - `GET /api/production/recipe-square-links` returns `packaging_format` in each row
  - `POST /api/production/recipe-square-links` accepts optional `packaging_format` in body; validates that can links require a format, keg links must not provide one
  - `LinkRow.packaging_format: string | null` added to `SquareLinkManager.tsx`

- [ ] **Step 1: Update GET to return `packaging_format`**

  In `app/api/production/recipe-square-links/route.ts`, the `GET` handler's `.select()` call currently uses `"*, recipes(beer_name), packaging_items(id, name, type, volume_fl_oz)"`. Because `packaging_format` is a column on the table, `*` already includes it. No change needed to the query. Confirm by reading the file — if the select uses `*`, it's already covered.

  The `LinkRow` interface in `SquareLinkManager.tsx` (line 10–20) does **not** include `packaging_format`. Add it:

  ```ts
  // In app/production/components/SquareLinkManager.tsx
  export interface LinkRow {
    id: string;
    recipe_id: string;
    packaging: "draft" | "keg" | "can";
    packaging_item_id: string | null;
    packaging_format: string | null;   // ← add this
    square_variation_id: string;
    variation_name: string | null;
    item_name: string | null;
    recipes?: { beer_name: string } | null;
    packaging_items?: { id: string; name: string; type: string; volume_fl_oz: number | null } | null;
  }
  ```

- [ ] **Step 2: Update POST to accept + validate `packaging_format`**

  In `app/api/production/recipe-square-links/route.ts`, replace the `POST` handler body:

  ```ts
  export async function POST(req: NextRequest) {
    try { await requireRole([]); } catch (res) { return res as Response; }

    const supabase = await createSupabaseServerClient();

    const {
      recipe_id, packaging, packaging_item_id,
      packaging_format,
      square_variation_id, square_item_id, variation_name, item_name,
    } = await req.json();

    if (!recipe_id || !packaging || !square_variation_id) {
      return NextResponse.json(
        { error: "recipe_id, packaging, and square_variation_id are required" },
        { status: 400 }
      );
    }

    // keg/can require a packaging_item_id
    if ((packaging === "keg" || packaging === "can") && !packaging_item_id) {
      return NextResponse.json(
        { error: "packaging_item_id is required for keg and can links" },
        { status: 400 }
      );
    }

    // can links require a packaging_format; keg/draft links must not have one
    if (packaging === "can" && !packaging_format) {
      return NextResponse.json(
        { error: "packaging_format is required for can links ('loose', '4-pack', '6-pack', or 'case')" },
        { status: 400 }
      );
    }
    if (packaging !== "can" && packaging_format) {
      return NextResponse.json(
        { error: "packaging_format is only valid for can links" },
        { status: 400 }
      );
    }

    const VALID_FORMATS = ["loose", "4-pack", "6-pack", "case"];
    if (packaging_format && !VALID_FORMATS.includes(packaging_format)) {
      return NextResponse.json(
        { error: `packaging_format must be one of: ${VALID_FORMATS.join(", ")}` },
        { status: 400 }
      );
    }

    let catalog_item_id: string | null = null;
    let catalog_variation_id: string | null = null;

    if (square_item_id) {
      const { data: master } = await supabase
        .from("square_catalog_items")
        .select("id")
        .eq("square_item_id", square_item_id)
        .single();
      catalog_item_id = master?.id ?? null;
    }

    if (square_variation_id) {
      const { data: variation } = await supabase
        .from("square_catalog_variations")
        .select("id")
        .eq("square_variation_id", square_variation_id)
        .single();
      catalog_variation_id = variation?.id ?? null;
    }

    const { data, error } = await supabase
      .from("recipe_square_links")
      .insert({
        recipe_id,
        packaging,
        packaging_item_id: packaging_item_id || null,
        packaging_format: packaging_format || null,
        square_variation_id,
        square_item_id: square_item_id || null,
        variation_name: variation_name || null,
        item_name: item_name || null,
        catalog_item_id,
        catalog_variation_id,
      })
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  }
  ```

- [ ] **Step 3: Update `linkedCombos` key in `SquareLinkManager` to include format**

  In `app/production/components/SquareLinkManager.tsx`, around line 188, the `linkedCombos` Set currently uses `recipe_id|packaging|packaging_item_id` as key. For can links this would produce duplicate-key false positives (two 4-pack vs 6-pack rows for same can would look identical). Update to include `packaging_format`:

  ```ts
  const linkedCombos = new Set(
    links.map((l) => `${l.recipe_id}|${l.packaging}|${l.packaging_item_id ?? ""}|${l.packaging_format ?? ""}`)
  );
  function availableRecipes(row: PendingRow): Recipe[] {
    const needsItem = row.packaging === "keg" || row.packaging === "can";
    if (needsItem && !row.packaging_item_id) return recipes;
    const fmt = row.packaging_format ?? "";
    return recipes.filter((r) => !linkedCombos.has(`${r.id}|${row.packaging}|${row.packaging_item_id}|${fmt}`));
  }
  ```

  This requires `PendingRow` to have `packaging_format`. Update the interface at the top of the file:

  ```ts
  interface PendingRow {
    uid: number;
    recipe_id: string;
    packaging: PackagingType;
    packaging_item_id: string;
    packaging_format: string;  // ← add; "" means not selected
    variation_id: string;
  }

  function newRow(): PendingRow {
    return { uid: uidSeed++, recipe_id: "", packaging: "keg", packaging_item_id: "", packaging_format: "", variation_id: "" };
  }
  ```

  Also update `updateRow` to reset `packaging_format` when `packaging` changes away from "can":
  ```ts
  function updateRow(uid: number, patch: Partial<PendingRow>) {
    setRows((rs) => rs.map((r) => {
      if (r.uid !== uid) return r;
      const next = { ...r, ...patch };
      if (patch.packaging && patch.packaging !== r.packaging) {
        next.packaging_item_id = "";
        next.variation_id = "";
        next.packaging_format = "";
      }
      if (patch.packaging_item_id && patch.packaging_item_id !== r.packaging_item_id) {
        next.variation_id = "";
      }
      return next;
    }));
  }
  ```

  Update `validRows` to require `packaging_format` for cans:
  ```ts
  const validRows = rows.filter((r) => {
    if (!r.recipe_id || !r.variation_id) return false;
    if (r.packaging === "draft") return true;
    if (!r.packaging_item_id) return false;
    if (r.packaging === "can" && !r.packaging_format) return false;
    return true;
  });
  ```

  Update `saveAll` to include `packaging_format` in the POST body:
  ```ts
  body: JSON.stringify({
    recipe_id: r.recipe_id,
    packaging: r.packaging,
    packaging_item_id: r.packaging_item_id || null,
    packaging_format: r.packaging_format || null,
    square_variation_id: r.variation_id,
    square_item_id: sv?.item_id ?? null,
    variation_name: sv?.variation_name ?? null,
    item_name: sv?.item_name ?? null,
  }),
  ```

- [ ] **Step 4: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero new TS errors introduced by this task.

- [ ] **Step 5: Commit**

  ```bash
  git add app/api/production/recipe-square-links/route.ts \
          app/production/components/SquareLinkManager.tsx
  git commit -m "feat: recipe_square_links API + LinkRow — add packaging_format for can format dimension"
  ```

---

## Task 3: SquareLinkManager UI — Format Dropdown for Cans

**Files:**
- Modify: `app/production/components/SquareLinkManager.tsx`

**Interfaces:**
- Consumes: Task 2 (`PendingRow.packaging_format`, `packaging_format` in POST body)
- Produces: Format dropdown appears for can rows; quick-add expands 4-pack + case rows per can item by default

- [ ] **Step 1: Add Format dropdown in the pending-row form**

  In the "Recipe & Packaging" section of each pending row (around line 385–440 in `SquareLinkManager.tsx`), after the existing `{needsPackagingItem && (...)}` block, add the format dropdown for cans. Insert after the keg/can size selector block:

  ```tsx
  {/* Format — cans only */}
  {row.packaging === "can" && (
    <div>
      <label className="block text-[10px] text-zinc-600 mb-1">Format</label>
      <select
        className="inp text-sm w-full"
        value={row.packaging_format}
        onChange={(e) => updateRow(row.uid, { packaging_format: e.target.value })}
        disabled={!row.packaging_item_id}
      >
        <option value="">— select format —</option>
        <option value="loose">Loose (single)</option>
        <option value="4-pack">4-Pack</option>
        <option value="6-pack">6-Pack</option>
        <option value="case">Case</option>
      </select>
    </div>
  )}
  ```

  Place this inside the `<div className="flex gap-2">` that also holds the Type buttons and the keg/can size selector, so all three controls sit on the same row. The resulting layout for a can row is: `[Type buttons] [Can Size] [Format]`.

- [ ] **Step 2: Update `filterVariations` for cans to include all formats**

  Currently `filterVariations("can")` excludes `pack|case` in the variation name. Remove that filter — for cans with a format, the user should be able to select any variation (the format dimension on the DB row distinguishes them, not the variation name):

  ```ts
  function filterVariations(packaging: PackagingType): SquareVariation[] {
    const cat = CATEGORY_FOR[packaging];
    return sqVariations.filter((v) => {
      if (v.category_name !== cat) return false;
      if (packaging === "draft") return !/- \d+oz$/i.test(v.variation_name);
      // cans: no variation-name filter — format is tracked as packaging_format
      return true;
    });
  }
  ```

- [ ] **Step 3: Update quick-add to expand 4-pack + case rows for cans**

  Replace the `expandRecipe` function:

  ```ts
  function expandRecipe() {
    if (!expandRecipeId) return;
    const kegItems = packagingItems.filter((p) => p.type === "keg");
    const canItems = packagingItems.filter((p) => p.type === "can");
    const newRows: PendingRow[] = [
      ...kegItems.map((item) => ({
        uid: uidSeed++, recipe_id: expandRecipeId,
        packaging: "keg" as PackagingType, packaging_item_id: item.id,
        packaging_format: "", variation_id: "",
      })),
      // Default can formats: 4-pack and case
      ...canItems.flatMap((item) => (
        ["4-pack", "case"] as const
      ).map((fmt) => ({
        uid: uidSeed++, recipe_id: expandRecipeId,
        packaging: "can" as PackagingType, packaging_item_id: item.id,
        packaging_format: fmt, variation_id: "",
      }))),
      {
        uid: uidSeed++, recipe_id: expandRecipeId,
        packaging: "draft" as PackagingType, packaging_item_id: "",
        packaging_format: "", variation_id: "",
      },
    ];
    setRows((rs) => {
      const isDefaultBlank = rs.length === 1 && !rs[0].recipe_id && !rs[0].variation_id;
      return isDefaultBlank ? newRows : [...rs, ...newRows];
    });
    setExpandRecipeId("");
  }
  ```

- [ ] **Step 4: Display `packaging_format` in the Existing Links list**

  In the "Existing Links" section (around line 518), after the `packaging_items` name span, show the format badge for can links:

  ```tsx
  {l.packaging_items && (
    <span className="text-zinc-300 font-medium shrink-0">
      {l.packaging_items.name}
      {l.packaging_items.volume_fl_oz && (
        <span className="text-zinc-600 font-normal"> ({l.packaging_items.volume_fl_oz} fl oz)</span>
      )}
      {l.packaging_format && (
        <span className="text-zinc-500 font-normal"> · {l.packaging_format}</span>
      )}
    </span>
  )}
  ```

- [ ] **Step 5: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero new TS errors.

- [ ] **Step 6: Commit**

  ```bash
  git add app/production/components/SquareLinkManager.tsx
  git commit -m "feat: SquareLinkManager — format dropdown for can links, quick-add 4-pack+case"
  ```

---

## Task 4: Export Invoice Preview — Channel Branching

**Files:**
- Modify: `lib/production/exportInvoicePreview.ts`

**Interfaces:**
- Consumes: Task 0 (DB has `wholesale` channel), Task 1 (`ExportChannel` includes `wholesale`)
- Produces: `buildInvoicePreview()` branches on channel; `distribution` → product lines + excise + optional distribution_discount; `wholesale` → product lines + optional wholesale_discount (no excise); `contract_brewing` → unchanged

- [ ] **Step 1: Extend `ExportTxRow` to include `channel` and `recipe_id`**

  In `lib/production/exportInvoicePreview.ts`, update the `ExportTxRow` interface:

  ```ts
  interface ExportTxRow {
    id: string;
    recipient_id: string | null;
    status: string;
    quantity: number;
    volume_bbl: number;
    packaging_item_id: string;
    packaging_format: string | null;
    units_per_package: number;
    channel: string;       // ← add
    recipe_id: string | null;  // ← add
  }
  ```

- [ ] **Step 2: Update the transaction SELECT to fetch `channel` and `recipe_id`**

  In the transaction load query (around line 47), update the select string:

  ```ts
  const { data: txs, error: txErr } = await supabase
    .from("export_transactions")
    .select("id, recipient_id, status, quantity, volume_bbl, packaging_item_id, packaging_format, units_per_package, channel, recipe_id")
    .in("id", transactionIds);
  ```

- [ ] **Step 3: Add channel guard after loading transactions**

  After validating `customerId` (around line 63), add channel validation:

  ```ts
  // Validate all transactions share the same channel
  const channels = new Set(rows.map((r) => r.channel));
  if (channels.size !== 1) {
    throw new Error("All selected transactions must share the same channel — mixed-channel invoices are not supported");
  }
  const channel = rows[0].channel as string;
  ```

- [ ] **Step 4: Add `buildProductLines` helper for distribution/wholesale**

  Add this helper function before `buildInvoicePreview` in the file:

  ```ts
  async function buildProductLines(
    supabase: SupabaseClient,
    rows: ExportTxRow[],
    priceByVariationId: Map<string, number>
  ): Promise<InvoiceLineItemDraft[]> {
    // Load recipe_square_links for all recipe+packaging_item combos in these transactions
    const recipeIds = [...new Set(rows.map((r) => r.recipe_id).filter((id): id is string => !!id))];
    const packagingItemIds = [...new Set(rows.map((r) => r.packaging_item_id))];

    const { data: links } = await supabase
      .from("recipe_square_links")
      .select("recipe_id, packaging_item_id, packaging_format, square_variation_id, packaging_items(name)")
      .in("recipe_id", recipeIds)
      .in("packaging_item_id", packagingItemIds);

    const linkMap = new Map(
      (links ?? []).map((l) => [
        `${l.recipe_id}|${l.packaging_item_id}|${l.packaging_format ?? ""}`,
        l,
      ])
    );

    const lineItems: InvoiceLineItemDraft[] = [];
    for (const tx of rows) {
      if (!tx.recipe_id) {
        throw new Error(
          `Transaction ${tx.id} has no recipe — cannot build product line items for this channel`
        );
      }
      const fmt = tx.packaging_format ?? "";
      const key = `${tx.recipe_id}|${tx.packaging_item_id}|${fmt}`;
      const link = linkMap.get(key);
      if (!link?.square_variation_id) {
        const pkgName = (link as { packaging_items?: { name: string } } | undefined)?.packaging_items?.name ?? tx.packaging_item_id;
        throw new Error(
          `No Square product link found for recipe + "${pkgName}" (format: ${fmt || "none"}) — ` +
          `go to Production → Link Styles to Square and add this mapping before generating a Distribution or Wholesale invoice.`
        );
      }
      lineItems.push({
        id: crypto.randomUUID(),
        description: `${link.square_variation_id}`,  // replaced below with item name if available
        quantity: tx.quantity,
        unitPriceCents: priceByVariationId.get(link.square_variation_id) ?? 0,
        squareCatalogVariationId: link.square_variation_id,
      });
    }
    return lineItems;
  }
  ```

  > The `description` field will use the variation's display name. Since we have `square_variation_id` (the Square API ID), the Square invoice API will render the item name from the catalog — but `description` is a fallback label. Improve it by joining item/variation name from Square catalog if needed; the simpler approach is to store `item_name` on `recipe_square_links` (it's already there from the existing insert logic). Update the `buildProductLines` select to include `item_name, variation_name`:

  ```ts
  const { data: links } = await supabase
    .from("recipe_square_links")
    .select("recipe_id, packaging_item_id, packaging_format, square_variation_id, item_name, variation_name")
    .in("recipe_id", recipeIds)
    .in("packaging_item_id", packagingItemIds);
  ```

  Update the description assignment:
  ```ts
  lineItems.push({
    id: crypto.randomUUID(),
    description: link.item_name
      ? `${link.item_name}${link.variation_name ? ` · ${link.variation_name}` : ""}${fmt ? ` (${fmt})` : ""}`
      : link.square_variation_id,
    quantity: tx.quantity,
    unitPriceCents: priceByVariationId.get(link.square_variation_id) ?? 0,
    squareCatalogVariationId: link.square_variation_id,
  });
  ```

- [ ] **Step 5: Replace the channel-blind invoice body with a channel branch**

  The current code after loading service mappings and catalog prices (step 5a onward) builds contract_brewing-style lines unconditionally. Replace the entire block from `const lineItems: InvoiceLineItemDraft[] = [];` to the end of the function body with:

  ```ts
  const lineItems: InvoiceLineItemDraft[] = [];

  if (channel === "contract_brewing") {
    // ── 5a. Packaging Fee lines (same as before) ────────────────────────────
    const kegFeeTransactionIds = new Set<string>();
    for (const tx of rows) {
      const isKeg = pkgTypeById.get(tx.packaging_item_id) === "keg";
      const containerName = pkgNameById.get(tx.packaging_item_id) ?? "unknown container";
      if (isKeg) kegFeeTransactionIds.add(tx.id);

      const mapFormat = isKeg ? null : tx.packaging_format ?? "loose";
      const discountCatalogId = isKeg
        ? findMapping("bulk_discount", null)?.square_catalog_discount_id ?? null
        : null;

      if (mapFormat === "case") {
        const wholeCases = Math.floor(tx.quantity + 1e-9);
        const remainder = tx.quantity - wholeCases;
        const looseUnits = Math.round(remainder * (tx.units_per_package || 1));

        if (wholeCases > 0) {
          const caseMapping = findMapping("packaging_fee", tx.packaging_item_id, "case");
          if (!caseMapping?.square_catalog_variation_id) {
            throw new Error(
              `Packaging Fee (Case) is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
            );
          }
          lineItems.push({
            id: crypto.randomUUID(),
            description: caseMapping.display_name,
            quantity: wholeCases,
            unitPriceCents: priceByVariationId.get(caseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: caseMapping.square_catalog_variation_id,
            discountCatalogId,
          });
        }
        if (looseUnits > 0) {
          const looseMapping = findMapping("packaging_fee", tx.packaging_item_id, "loose");
          if (!looseMapping?.square_catalog_variation_id) {
            throw new Error(
              `Packaging Fee (Loose Can) is not configured for "${containerName}" — set it in Export Settings before generating this invoice (needed for the partial-case remainder).`
            );
          }
          lineItems.push({
            id: crypto.randomUUID(),
            description: looseMapping.display_name,
            quantity: looseUnits,
            unitPriceCents: priceByVariationId.get(looseMapping.square_catalog_variation_id) ?? 0,
            squareCatalogVariationId: looseMapping.square_catalog_variation_id,
            discountCatalogId,
          });
        }
        continue;
      }

      const mapping = findMapping("packaging_fee", tx.packaging_item_id, mapFormat);
      if (!mapping?.square_catalog_variation_id) {
        throw new Error(
          `Packaging Fee is not configured for "${containerName}" — set it in Export Settings before generating this invoice.`
        );
      }
      lineItems.push({
        id: crypto.randomUUID(),
        description: mapping.display_name,
        quantity: tx.quantity,
        unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
        squareCatalogVariationId: mapping.square_catalog_variation_id,
        discountCatalogId,
      });
    }

    // ── 5b. Excise Tax ──────────────────────────────────────────────────────
    const { data: taxRows } = await supabase
      .from("export_transaction_taxes")
      .select("export_transaction_id, amount_usd, excise_tax_rate_id")
      .in("export_transaction_id", transactionIds);

    if (taxRows && taxRows.length > 0) {
      const rateIds = [...new Set(taxRows.map((t) => t.excise_tax_rate_id).filter((id): id is string => !!id))];
      const { data: rates } = await supabase
        .from("excise_tax_rates")
        .select("id, receiving_party, unit, square_catalog_variation_id")
        .in("id", rateIds);
      const rateById = new Map((rates ?? []).map((r) => [r.id, r]));
      const volumeByTx = new Map(rows.map((r) => [r.id, r.volume_bbl]));

      const byParty = new Map<string, { amountCents: number; units: number; unit: "bbl" | "gallon"; variationId: string | null }>();
      for (const t of taxRows) {
        const rate = t.excise_tax_rate_id ? rateById.get(t.excise_tax_rate_id) : undefined;
        const party = rate?.receiving_party ?? "Unknown";
        const volumeBbl = volumeByTx.get(t.export_transaction_id) ?? 0;
        const unit = (rate?.unit ?? "bbl") as "bbl" | "gallon";
        const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
        const entry = byParty.get(party) ?? { amountCents: 0, units: 0, unit, variationId: rate?.square_catalog_variation_id ?? null };
        entry.amountCents += Math.round(t.amount_usd * 100);
        entry.units += units;
        byParty.set(party, entry);
      }

      for (const [party, entry] of byParty) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: `Excise Tax — ${party} (${entry.units.toFixed(2)} ${entry.unit}${entry.units !== 1 ? "s" : ""})`,
          quantity: 1,
          unitPriceCents: entry.amountCents,
          squareCatalogVariationId: entry.variationId,
        });
      }
    }

    // ── 5c. Keg Cleaning ────────────────────────────────────────────────────
    if (kegFeeTransactionIds.size > 0) {
      const mapping = findMapping("keg_cleaning", null);
      if (mapping?.square_catalog_variation_id) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: mapping.display_name,
          quantity: kegFeeTransactionIds.size,
          unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
          squareCatalogVariationId: mapping.square_catalog_variation_id,
        });
      }
    }

    // ── 5d. Forklift ────────────────────────────────────────────────────────
    {
      const mapping = findMapping("forklift", null);
      if (mapping?.square_catalog_variation_id) {
        lineItems.push({
          id: crypto.randomUUID(),
          description: mapping.display_name,
          quantity: 1,
          unitPriceCents: priceByVariationId.get(mapping.square_catalog_variation_id) ?? 0,
          squareCatalogVariationId: mapping.square_catalog_variation_id,
        });
      }
    }

  } else if (channel === "distribution" || channel === "wholesale") {
    // ── Product lines (from recipe_square_links) ────────────────────────────
    const productLines = await buildProductLines(supabase, rows, priceByVariationId);

    // Apply channel-appropriate discount to all product lines
    const discountServiceType = channel === "distribution" ? "distribution_discount" : "wholesale_discount";
    const discountMapping = findMapping(discountServiceType, null);
    const discountCatalogId = discountMapping?.square_catalog_discount_id ?? null;

    for (const line of productLines) {
      lineItems.push({ ...line, discountCatalogId });
    }

    // ── Excise Tax (distribution only) ─────────────────────────────────────
    if (channel === "distribution") {
      const { data: taxRows } = await supabase
        .from("export_transaction_taxes")
        .select("export_transaction_id, amount_usd, excise_tax_rate_id")
        .in("export_transaction_id", transactionIds);

      if (taxRows && taxRows.length > 0) {
        const rateIds = [...new Set(taxRows.map((t) => t.excise_tax_rate_id).filter((id): id is string => !!id))];
        const { data: rates } = await supabase
          .from("excise_tax_rates")
          .select("id, receiving_party, unit, square_catalog_variation_id")
          .in("id", rateIds);
        const rateById = new Map((rates ?? []).map((r) => [r.id, r]));
        const volumeByTx = new Map(rows.map((r) => [r.id, r.volume_bbl]));

        const byParty = new Map<string, { amountCents: number; units: number; unit: "bbl" | "gallon"; variationId: string | null }>();
        for (const t of taxRows) {
          const rate = t.excise_tax_rate_id ? rateById.get(t.excise_tax_rate_id) : undefined;
          const party = rate?.receiving_party ?? "Unknown";
          const volumeBbl = volumeByTx.get(t.export_transaction_id) ?? 0;
          const unit = (rate?.unit ?? "bbl") as "bbl" | "gallon";
          const units = unit === "bbl" ? volumeBbl : volumeBbl * GALLONS_PER_BBL;
          const entry = byParty.get(party) ?? { amountCents: 0, units: 0, unit, variationId: rate?.square_catalog_variation_id ?? null };
          entry.amountCents += Math.round(t.amount_usd * 100);
          entry.units += units;
          byParty.set(party, entry);
        }

        for (const [party, entry] of byParty) {
          lineItems.push({
            id: crypto.randomUUID(),
            description: `Excise Tax — ${party} (${entry.units.toFixed(2)} ${entry.unit}${entry.units !== 1 ? "s" : ""})`,
            quantity: 1,
            unitPriceCents: entry.amountCents,
            squareCatalogVariationId: entry.variationId,
            // No discount on excise tax lines
          });
        }
      }
    }

  } else {
    throw new Error(`Unsupported invoice channel: ${channel}`);
  }

  return {
    customerId,
    customerName: partner.company_name,
    squareCustomerId: partner.square_customer_id,
    lineItems,
    dueDays,
  };
  ```

- [ ] **Step 6: Remove the old unconditional line-item block**

  The old code from `const lineItems: InvoiceLineItemDraft[] = [];` through the closing `return { ... }` is now fully replaced by the block above. Delete the old version so there is no duplication.

- [ ] **Step 7: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero TS errors in `exportInvoicePreview.ts`.

- [ ] **Step 8: Commit**

  ```bash
  git add lib/production/exportInvoicePreview.ts
  git commit -m "feat: exportInvoicePreview — channel-branched line items for distribution + wholesale"
  ```

---

## Task 5: ExportSettingsPanel — New Discount Sections

**Files:**
- Modify: `app/production/components/ExportSettingsPanel.tsx`

**Interfaces:**
- Consumes: Task 1 (`ServiceType` includes `"distribution_discount" | "wholesale_discount"`)
- Produces: `DistributionDiscountSection` and `WholesaleDiscountSection` rendered in `ExportSettingsPanel`; both follow the exact same pattern as `BulkDiscountSection`

- [ ] **Step 1: Add `DistributionDiscountSection` component**

  After the closing `}` of `BulkDiscountSection` (around line 498), add:

  ```tsx
  function DistributionDiscountSection() {
    const { data: mappings = [] } = useExportServiceMappingsQuery();
    const { data: partners = [] } = useContractPartnersQuery();
    const { data: catalog } = useExportSquareCatalogQuery();
    const qc = useQueryClient();
    const discounts = catalog?.discounts ?? [];

    const rows = mappings.filter((m) => m.service_type === "distribution_discount");
    const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
    const overrideRows = rows.filter((m) => m.partner_id !== null);

    async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
      await fetch("/api/production/export-settings/service-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: existing?.id,
          service_type: "distribution_discount",
          partner_id: partnerId,
          display_name: "Distribution Discount",
          square_catalog_discount_id: discountId,
        }),
      });
      await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
    }

    return (
      <section>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">Distribution Discount</h3>
        <p className="text-xs text-zinc-600 mb-2">
          Applied to product line items on Distribution invoices. Optional — omit to generate without a discount.
        </p>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 italic w-28">Default</span>
            <SquareDiscountSelect
              discounts={discounts}
              value={defaultRow?.square_catalog_discount_id ?? null}
              onChange={(id) => upsert(defaultRow, null, id)}
            />
          </div>
          {overrideRows.map((m) => {
            const partner = partners.find((p) => p.id === m.partner_id);
            return (
              <div key={m.id} className="flex items-center gap-2">
                <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
                <SquareDiscountSelect
                  discounts={discounts}
                  value={m.square_catalog_discount_id}
                  onChange={(id) => upsert(m, m.partner_id, id)}
                />
              </div>
            );
          })}
          <PartnerOverridePicker
            partners={partners}
            excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
            onAdd={(partnerId) => upsert(null, partnerId, null)}
          />
        </div>
      </section>
    );
  }
  ```

- [ ] **Step 2: Add `WholesaleDiscountSection` component**

  Immediately after `DistributionDiscountSection`, add:

  ```tsx
  function WholesaleDiscountSection() {
    const { data: mappings = [] } = useExportServiceMappingsQuery();
    const { data: partners = [] } = useContractPartnersQuery();
    const { data: catalog } = useExportSquareCatalogQuery();
    const qc = useQueryClient();
    const discounts = catalog?.discounts ?? [];

    const rows = mappings.filter((m) => m.service_type === "wholesale_discount");
    const defaultRow = rows.find((m) => m.partner_id === null) ?? null;
    const overrideRows = rows.filter((m) => m.partner_id !== null);

    async function upsert(existing: ExportServiceMapping | null, partnerId: string | null, discountId: string | null) {
      await fetch("/api/production/export-settings/service-mappings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: existing?.id,
          service_type: "wholesale_discount",
          partner_id: partnerId,
          display_name: "Wholesale Discount",
          square_catalog_discount_id: discountId,
        }),
      });
      await qc.invalidateQueries({ queryKey: queryKeys.production.exportServiceMappings() });
    }

    return (
      <section>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">Wholesale Discount</h3>
        <p className="text-xs text-zinc-600 mb-2">
          Applied to product line items on Wholesale invoices. Optional — omit to generate without a discount.
        </p>
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-zinc-500 italic w-28">Default</span>
            <SquareDiscountSelect
              discounts={discounts}
              value={defaultRow?.square_catalog_discount_id ?? null}
              onChange={(id) => upsert(defaultRow, null, id)}
            />
          </div>
          {overrideRows.map((m) => {
            const partner = partners.find((p) => p.id === m.partner_id);
            return (
              <div key={m.id} className="flex items-center gap-2">
                <span className="text-xs text-zinc-300 w-28 truncate">{partner?.company_name ?? "Unknown partner"}</span>
                <SquareDiscountSelect
                  discounts={discounts}
                  value={m.square_catalog_discount_id}
                  onChange={(id) => upsert(m, m.partner_id, id)}
                />
              </div>
            );
          })}
          <PartnerOverridePicker
            partners={partners}
            excludeIds={new Set(overrideRows.map((m) => m.partner_id!))}
            onAdd={(partnerId) => upsert(null, partnerId, null)}
          />
        </div>
      </section>
    );
  }
  ```

- [ ] **Step 3: Render new sections in `ExportSettingsPanel`**

  In the `ExportSettingsPanel` default export (around line 549), the current `scope === "full"` block ends with `<BulkDiscountSection />`. Add the two new sections after it:

  ```tsx
  export default function ExportSettingsPanel({ scope }: { scope: "full" | "excise-only" }) {
    return (
      <div className="flex flex-col gap-8">
        <ExciseTaxRatesSection />
        {scope === "full" && (
          <>
            <section>
              <h3 className="text-sm font-medium text-zinc-200 mb-3">Service Mappings</h3>
              <div className="flex flex-col gap-6">
                <PackagingFeeSection />
                <SimpleServiceSection serviceType="keg_cleaning" />
                <SimpleServiceSection serviceType="forklift" />
              </div>
            </section>
            <BulkDiscountSection />
            <DistributionDiscountSection />
            <WholesaleDiscountSection />
            <InvoiceTermsSection />
          </>
        )}
      </div>
    );
  }
  ```

- [ ] **Step 4: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero TS errors.

- [ ] **Step 5: Commit**

  ```bash
  git add app/production/components/ExportSettingsPanel.tsx
  git commit -m "feat: ExportSettingsPanel — distribution_discount and wholesale_discount sections"
  ```

---

## Task 6: UI — Commitments Tab + Export Bay Tab + BatchLogTab

**Files:**
- Modify: `app/production/components/intake/CommitmentsTab.tsx`
- Modify: `app/production/components/ExportBayTab.tsx`
- Modify: `app/production/components/BatchLogTab.tsx`

**Interfaces:**
- Consumes: Task 1 (`CommitmentChannel`, `ExportChannel`, `AllocationChannel` include `wholesale`)
- Produces:
  - `CommitmentsTab`: `CHANNEL_META` has `wholesale` entry; deposit gating label covers all non-contract_brewing; channel filter includes wholesale
  - `ExportBayTab`: ad-hoc export channel dropdown has `<option value="wholesale">Wholesale</option>`
  - `BatchLogTab`: `CHANNEL_OPTIONS` and `CHANNEL_COLOR` have `wholesale` entries

- [ ] **Step 1: Update `CHANNEL_META` in `CommitmentsTab.tsx`**

  In `app/production/components/intake/CommitmentsTab.tsx` (line 26–29), `CHANNEL_META` is:

  ```ts
  const CHANNEL_META: Record<CommitmentChannel, { label: string; cls: string }> = {
    distribution:     { label: "Distribution",     cls: "bg-blue-900/40 text-blue-300 border-blue-800" },
    contract_brewing: { label: "Contract Brewing", cls: "bg-purple-900/40 text-purple-300 border-purple-800" },
  };
  ```

  Add the wholesale entry:

  ```ts
  const CHANNEL_META: Record<CommitmentChannel, { label: string; cls: string }> = {
    distribution:     { label: "Distribution",     cls: "bg-blue-900/40 text-blue-300 border-blue-800" },
    contract_brewing: { label: "Contract Brewing", cls: "bg-purple-900/40 text-purple-300 border-purple-800" },
    wholesale:        { label: "Wholesale",         cls: "bg-teal-900/40 text-teal-300 border-teal-800" },
  };
  ```

- [ ] **Step 2: Update the deposit gating label**

  In `CommitmentsTab.tsx`, around line 70:

  ```tsx
  // before
  if (commitment.channel !== "contract_brewing") return <span className="text-zinc-600">—</span>;

  // after — also update the tooltip/text to be informative
  if (commitment.channel !== "contract_brewing") {
    return <span className="text-zinc-600 text-xs">— (Deposit invoices are only used for Contract Brewing)</span>;
  }
  ```

  Find the exact line — it may be `<span className="text-zinc-600">—</span>` at the early return in `InvoicingCell` (line 70 area). Replace only the return statement, not the rest of the function.

- [ ] **Step 3: Add `wholesale` to the channel filter chips in `CommitmentsTab.tsx`**

  Search for where the channel filter tabs/chips are rendered (around line 620–630 where `CHANNEL_META[f].label` is called). The filter type will need `"wholesale"` added to its union or options array. Find the line that maps over filter values and ensure `wholesale` is included:

  ```ts
  // Look for something like:
  const FILTER_CHANNELS: Array<CommitmentChannel | "all"> = ["all", "distribution", "contract_brewing"];
  // Change to:
  const FILTER_CHANNELS: Array<CommitmentChannel | "all"> = ["all", "distribution", "contract_brewing", "wholesale"];
  ```

  If the filter is built differently (e.g., from `Object.keys(CHANNEL_META)`), it will automatically pick up the new entry — verify by reading the section.

- [ ] **Step 4: Add `Wholesale` to the new-commitment channel dropdown in `CommitmentsTab.tsx`**

  Find the channel `<select>` in the new/edit commitment form (around line 285–292 where `CHANNEL_META[c].label` is used). The options map over `Object.keys(CHANNEL_META)` or a hardcoded array. If hardcoded, add wholesale:

  ```tsx
  <option value="wholesale">Wholesale</option>
  ```

  If it iterates `Object.keys(CHANNEL_META)`, the new entry is automatic.

- [ ] **Step 5: Add `Wholesale` to the ad-hoc export channel select in `ExportBayTab.tsx`**

  In `app/production/components/ExportBayTab.tsx` (around line 413–416):

  ```tsx
  // before
  <select className="inp w-full" value={channel} onChange={(e) => setChannel(e.target.value as ExportChannel)}>
    <option value="taproom">Taproom</option>
    <option value="distribution">Distribution</option>
    <option value="contract_brewing">Contract Brewing</option>
  </select>

  // after — add wholesale
  <select className="inp w-full" value={channel} onChange={(e) => setChannel(e.target.value as ExportChannel)}>
    <option value="taproom">Taproom</option>
    <option value="distribution">Distribution</option>
    <option value="contract_brewing">Contract Brewing</option>
    <option value="wholesale">Wholesale</option>
  </select>
  ```

- [ ] **Step 6: Update `CHANNEL_OPTIONS` and `CHANNEL_COLOR` in `BatchLogTab.tsx`**

  In `app/production/components/BatchLogTab.tsx` (lines 396–409):

  ```ts
  const CHANNEL_OPTIONS: { value: AllocationChannel; label: string }[] = [
    { value: "taproom",          label: "Taproom" },
    { value: "distribution",     label: "Distribution" },
    { value: "contract_brewing", label: "Contract Brewing" },
    { value: "wholesale",        label: "Wholesale" },   // ← add
    { value: "safety_stock",     label: "Safety Stock" },
  ];

  const CHANNEL_COLOR: Record<AllocationChannel, { bg: string; text: string; bar: string }> = {
    taproom:          { bg: "bg-blue-900/50",    text: "text-blue-300",   bar: "#3b82f6" },
    distribution:     { bg: "bg-emerald-900/50", text: "text-emerald-300",bar: "#10b981" },
    contract_brewing: { bg: "bg-purple-900/50",  text: "text-purple-300", bar: "#8b5cf6" },
    wholesale:        { bg: "bg-teal-900/50",    text: "text-teal-300",   bar: "#14b8a6" },  // ← add
    safety_stock:     { bg: "bg-zinc-800",        text: "text-zinc-400",  bar: "#52525b" },
  };
  ```

- [ ] **Step 7: Build check — should now have zero TS errors**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  After this task, the TypeScript type maps are exhaustive for `wholesale` — all `Record<CommitmentChannel, ...>` and `Record<AllocationChannel, ...>` objects are updated. Expect zero TS errors total.

- [ ] **Step 8: Commit**

  ```bash
  git add app/production/components/intake/CommitmentsTab.tsx \
          app/production/components/ExportBayTab.tsx \
          app/production/components/BatchLogTab.tsx
  git commit -m "feat: UI — wholesale channel in CommitmentsTab, ExportBayTab, BatchLogTab"
  ```

---

## Task 7: Allocations API — Channel Validation

**Files:**
- Modify: `app/api/production/allocations/route.ts`

**Interfaces:**
- Consumes: Task 1 (`AllocationChannel` includes `wholesale`)
- Produces: `POST /api/production/allocations` rejects unknown channel values with a clear error before hitting the DB constraint

Note: The DB constraint from Task 0 already enforces valid values. This task adds an explicit API-layer check so the error message is readable rather than a raw Postgres constraint violation.

- [ ] **Step 1: Add channel validation in the POST handler**

  In `app/api/production/allocations/route.ts` (around line 109), after the existing param validation:

  ```ts
  if (!batch_id || !channel || percentage == null) {
    return NextResponse.json({ error: "batch_id, channel, and percentage are required" }, { status: 400 });
  }

  // Add after the above:
  const VALID_CHANNELS: string[] = ["taproom", "distribution", "contract_brewing", "wholesale", "safety_stock"];
  if (!VALID_CHANNELS.includes(channel)) {
    return NextResponse.json(
      { error: `Invalid channel "${channel}". Must be one of: ${VALID_CHANNELS.join(", ")}` },
      { status: 400 }
    );
  }
  ```

- [ ] **Step 2: Verify ship route requires no changes**

  In `app/api/production/export-bay/ship/route.ts`, the allocation query already uses `.neq("channel", "taproom")` to find all non-taproom allocations. Wholesale allocations will be included automatically — no change required. Read the file to confirm:

  ```bash
  grep -n "channel\|taproom" app/api/production/export-bay/ship/route.ts
  ```

  Expected: The only channel logic is `.neq("channel", "taproom")` which correctly includes wholesale. The ship route passes `channel` through from the allocation row to `writeExportTransaction` without filtering — confirm this is the case.

- [ ] **Step 3: Build check**

  ```bash
  npm run build 2>&1 | grep -E "error TS|Type error" | head -30
  ```

  Expected: Zero errors.

- [ ] **Step 4: Commit**

  ```bash
  git add app/api/production/allocations/route.ts
  git commit -m "feat: allocations API — explicit channel validation includes wholesale"
  ```

---

## Self-Review Checklist

**Spec coverage check:**

| Spec section | Covered by task |
|---|---|
| §4.1 DB constraints (4 tables) | Task 0 |
| §4.2 TypeScript types | Task 1 |
| §5 recipe_square_links format column + indexes | Task 0 |
| §5.4 API changes for packaging_format | Task 2 |
| §5.5 SquareLinkManager format dropdown | Task 3 |
| §6 Export invoice channel branching | Task 4 |
| §6.2 contract_brewing unchanged | Task 4 (5a–5d block) |
| §6.2 distribution: product lines + excise + distribution_discount | Task 4 |
| §6.2 wholesale: product lines + wholesale_discount, no excise | Task 4 |
| §7 Deposit invoice gating label | Task 6 |
| §8 ExportSettingsPanel new discount sections | Task 5 |
| §9 CommitmentsTab CHANNEL_META + dropdown | Task 6 |
| §10 ExportBayTab wholesale option | Task 6 |
| §11 Allocations API wholesale validation | Task 7 |
| §12 Ship route — wholesale auto-included | Task 7 (verify step) |

**Placeholder scan:** All steps contain actual code. No TBD or "similar to above" shortcuts.

**Type consistency check:**
- `PendingRow.packaging_format: string` (Task 2) is used in Task 3 format dropdown ✓
- `buildProductLines` (Task 4) uses `recipe_id` which is on `ExportTxRow` after Task 4 Step 1 ✓
- `distribution_discount` / `wholesale_discount` are in `ServiceType` (Task 1) and used in Task 5 upsert bodies ✓
- `findMapping("distribution_discount", null)` in Task 4 works because `findMapping` accepts `string` ✓
