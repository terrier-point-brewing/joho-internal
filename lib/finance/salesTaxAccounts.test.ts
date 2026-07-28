import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listSalesTaxAccounts, setSalesTaxAccount } from "./salesTaxAccounts";

/** Stub routing the three tables listSalesTaxAccounts touches. */
function stubSb(opts: {
  existing: { square_tax_id: string }[];
  observedPos: { square_tax_id: string; tax_name: string | null; tax_pct: number | null }[];
  observedInvoice?: { square_tax_id: string; tax_name: string | null; tax_pct: number | null }[];
  onInsert?: (rows: unknown[]) => void;
  onUpdate?: (patch: unknown, id: string) => void;
}) {
  const rows = [...opts.existing];
  const from = (table: string) => {
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.order = () => b;
    b.eq = (_c: string, v: string) => { (b as { _id?: string })._id = v; return b; };
    b.range = (f: number, t: number) => {
      const data =
        table === "square_tax_accounts" ? rows
        : table === "pos_line_item_taxes" ? opts.observedPos
        : opts.observedInvoice ?? [];
      return Promise.resolve({ data: data.slice(f, t + 1), error: null });
    };
    b.insert = (r: unknown[]) => { opts.onInsert?.(r); return Promise.resolve({ error: null }); };
    b.update = (patch: unknown) => {
      const u: Record<string, unknown> = {};
      u.eq = (_c: string, v: string) => { opts.onUpdate?.(patch, v); return Promise.resolve({ error: null }); };
      return u;
    };
    return b;
  };
  return { from } as unknown as SupabaseClient;
}

describe("listSalesTaxAccounts", () => {
  it("seeds a newly observed tax with a null account", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [{ square_tax_id: "TAX_GEN" }],
      observedPos: [
        { square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25 },
        { square_tax_id: "TAX_NEW", tax_name: "New City Tax", tax_pct: 0.5 },
      ],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([[
      { square_tax_id: "TAX_NEW", tax_name: "New City Tax", tax_pct: 0.5, chart_of_accounts_id: null },
    ]]);
  });

  it("inserts nothing when every observed tax already has a row", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [{ square_tax_id: "TAX_GEN" }],
      observedPos: [{ square_tax_id: "TAX_GEN", tax_name: "General Sales Tax", tax_pct: 7.25 }],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([]);
  });

  it("seeds taxes observed only on invoices", async () => {
    const inserted: unknown[][] = [];
    const sb = stubSb({
      existing: [],
      observedPos: [],
      observedInvoice: [{ square_tax_id: "TAX_INV", tax_name: "General Sales Tax", tax_pct: 7.25 }],
      onInsert: (r) => inserted.push(r),
    });
    await listSalesTaxAccounts(sb);
    expect(inserted).toEqual([[
      { square_tax_id: "TAX_INV", tax_name: "General Sales Tax", tax_pct: 7.25, chart_of_accounts_id: null },
    ]]);
  });
});

describe("setSalesTaxAccount", () => {
  it("updates the row's account and stamps updated_at", async () => {
    const seen: { patch: Record<string, unknown>; id: string }[] = [];
    const sb = stubSb({
      existing: [], observedPos: [],
      onUpdate: (patch, id) => seen.push({ patch: patch as Record<string, unknown>, id }),
    });
    await setSalesTaxAccount(sb, "TAX_GEN", "COA_1");
    expect(seen).toHaveLength(1);
    expect(seen[0].id).toBe("TAX_GEN");
    expect(seen[0].patch.chart_of_accounts_id).toBe("COA_1");
    expect(typeof seen[0].patch.updated_at).toBe("string");
  });

  it("accepts null to clear a mapping", async () => {
    const seen: { patch: Record<string, unknown>; id: string }[] = [];
    const sb = stubSb({
      existing: [], observedPos: [],
      onUpdate: (patch, id) => seen.push({ patch: patch as Record<string, unknown>, id }),
    });
    await setSalesTaxAccount(sb, "TAX_GEN", null);
    expect(seen[0].patch.chart_of_accounts_id).toBeNull();
  });
});
