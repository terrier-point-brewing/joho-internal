import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requirePermission } from "@/lib/auth";

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, requirePermission: vi.fn().mockResolvedValue(undefined) };
});

interface Recorded { table: string; payload: unknown }
let recorded: Recorded[] = [];
let insertCounter = 1;

// Includes one keg-type row so the "non-can container_id" test exercises a real filter,
// not a stub that returns the same fixture regardless of which id was requested.
const PACKAGING_ITEMS = [
  { id: "container-1", type: "can" },
  { id: "keg-container", type: "keg" },
];
const EXISTING_VARIATIONS = [
  {
    id: "existing-loose-1",
    container_id: "container-1",
    format: "loose",
    lid_id: "lid-1",
    paktech_id: null,
    tray_id: null,
    label_id: "label-1",
    partner_id: null,
  },
  {
    id: "existing-4pack-1",
    container_id: "container-1",
    format: "4-pack",
    lid_id: "lid-1",
    paktech_id: "paktech-1",
    tray_id: null,
    label_id: "label-1",
    partner_id: null,
  },
];

function packagingItemsChain() {
  return {
    select: (cols: string) => {
      if (cols === "id, type") {
        return { in: (_field: string, ids: string[]) => Promise.resolve({ data: PACKAGING_ITEMS.filter((c) => ids.includes(c.id)), error: null }) };
      }
      // computeTotalVolumeFlOz's / getUnitsPerPackage's single-row lookups (volume_fl_oz / can_count)
      return { eq: () => ({ single: () => Promise.resolve({ data: { volume_fl_oz: 16, can_count: 4 } }) }) };
    },
  };
}

function packagingVariationsChain() {
  return {
    select: (cols: string) => {
      if (cols.startsWith("id,")) {
        return { in: (_field: string, ids: string[]) => Promise.resolve({ data: EXISTING_VARIATIONS.filter((v) => ids.includes(v.container_id)), error: null }) };
      }
      return { in: () => Promise.resolve({ data: [], error: null }) };
    },
    insert: (payload: Record<string, unknown>[]) => {
      recorded.push({ table: "packaging_variations", payload });
      const rows = payload.map((p) => ({ id: `new-${insertCounter++}`, ...p }));
      return { select: () => Promise.resolve({ data: rows, error: null }) };
    },
  };
}

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({
    from: (table: string) => {
      if (table === "packaging_items") return packagingItemsChain();
      if (table === "packaging_variations") return packagingVariationsChain();
      throw new Error(`unexpected table in test: ${table}`);
    },
  })),
}));

function req(body: unknown) {
  return new NextRequest("http://localhost/api/production/packaging-variations/bulk", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const VALID_4PACK = {
  container_id: "container-1",
  format: "4-pack",
  lid_id: "lid-1",
  paktech_id: "paktech-new",
  tray_id: null,
  label_id: "label-1",
  partner_id: null,
  breaks_into_variation_id: null,
  name: "Test Beer - 16oz Labeled Can 4-Pack",
};

const VALID_CASE_EXISTING_SIBLING = {
  container_id: "container-1",
  format: "case",
  lid_id: "lid-1",
  paktech_id: "paktech-1",
  tray_id: "tray-1",
  label_id: "label-1",
  partner_id: null,
  breaks_into_variation_id: "existing-4pack-1",
  name: "Test Beer - 16oz Labeled Can Case",
};

describe("POST /api/production/packaging-variations/bulk", () => {
  beforeEach(() => {
    recorded = [];
    insertCounter = 1;
    vi.mocked(requirePermission).mockResolvedValue(undefined as never);
  });

  it("rejects an empty items array", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [] }));
    expect(res.status).toBe(400);
  });

  it("returns whatever requirePermission throws (permission gate)", async () => {
    vi.mocked(requirePermission).mockRejectedValueOnce(new Response(null, { status: 403 }) as never);
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_4PACK] }));
    expect(res.status).toBe(403);
  });

  it("rejects the whole request when a container_id is not type can", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [{ ...VALID_4PACK, container_id: "keg-container" }] }));
    expect(res.status).toBe(400);
  });

  it("skips a row that fails validateFormat instead of failing the batch", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      items: [{ ...VALID_4PACK, paktech_id: null }], // 4-pack requires paktech_id
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([
      { name: VALID_4PACK.name, reason: 'format "4-pack" requires paktech_id' },
    ]);
  });

  it("skips a row that duplicates an existing variation", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      items: [{
        container_id: "container-1",
        format: "loose",
        lid_id: "lid-1",
        paktech_id: null,
        tray_id: null,
        label_id: "label-1",
        partner_id: null,
        breaks_into_variation_id: null,
        name: "Duplicate of existing loose variation",
      }],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([{ name: "Duplicate of existing loose variation", reason: "already exists" }]);
  });

  it("inserts a valid, non-duplicate 4-pack row and returns 201", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_4PACK] }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.created.length).toBe(1);
    expect(json.skipped).toEqual([]);
    const insertCall = recorded.find((r) => r.table === "packaging_variations");
    expect(insertCall).toBeTruthy();
    expect((insertCall!.payload as unknown[]).length).toBe(1);
  });

  it("skips a non-case row that sets breaks_into_variation_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [{ ...VALID_4PACK, breaks_into_variation_id: "some-id" }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([
      { name: VALID_4PACK.name, reason: `only format "case" may set breaks_into_variation_id` },
    ]);
  });

  it("skips a case row missing paktech_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [{ ...VALID_CASE_EXISTING_SIBLING, paktech_id: null }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toEqual([
      { name: VALID_CASE_EXISTING_SIBLING.name, reason: 'format "case" requires paktech_id' },
    ]);
  });

  it("skips a case row missing breaks_into_variation_id", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [{ ...VALID_CASE_EXISTING_SIBLING, breaks_into_variation_id: null }] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.skipped).toEqual([
      { name: VALID_CASE_EXISTING_SIBLING.name, reason: 'format "case" requires breaks_into_variation_id' },
    ]);
  });

  it("creates a case row that breaks into an existing 4-pack sibling", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_CASE_EXISTING_SIBLING] }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.created.length).toBe(1);
    expect(json.skipped).toEqual([]);
    const caseInsert = recorded[recorded.length - 1].payload as Record<string, unknown>[];
    expect(caseInsert[0].breaks_into_variation_id).toBe("existing-4pack-1");
  });

  it("creates a case row that breaks into a 4-pack sibling created in the SAME batch", async () => {
    const caseWithBatchSibling = { ...VALID_CASE_EXISTING_SIBLING, breaks_into_variation_id: "batch:4-pack" };
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_4PACK, caseWithBatchSibling] }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.skipped).toEqual([]);
    expect(json.created.length).toBe(2);

    // Two separate insert() calls: phase 1 (4-pack) then phase 2 (case), in that order.
    const variationInserts = recorded.filter((r) => r.table === "packaging_variations");
    expect(variationInserts.length).toBe(2);
    const phase1Row = (variationInserts[0].payload as Record<string, unknown>[])[0];
    const phase2Row = (variationInserts[1].payload as Record<string, unknown>[])[0];
    expect(phase1Row.format).toBe("4-pack");
    expect(phase2Row.format).toBe("case");
    // The case's breaks_into_variation_id resolves to the id generated for the phase-1 insert.
    const createdPack = json.created.find((c: { format: string }) => c.format === "4-pack");
    expect(phase2Row.breaks_into_variation_id).toBe(createdPack.id);
  });

  it("skips a case row whose batch sibling was never created", async () => {
    const caseWithMissingSibling = { ...VALID_CASE_EXISTING_SIBLING, breaks_into_variation_id: "batch:6-pack" };
    const { POST } = await import("./route");
    const res = await POST(req({ items: [caseWithMissingSibling] }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([
      { name: VALID_CASE_EXISTING_SIBLING.name, reason: "breaks_into_variation_id references this batch's 6-pack, which was not created" },
    ]);
  });
});
