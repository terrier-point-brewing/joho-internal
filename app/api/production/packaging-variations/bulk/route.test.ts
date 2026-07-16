import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth";

vi.mock("@/lib/auth", () => ({
  requireRole: vi.fn().mockResolvedValue(undefined),
}));

interface Recorded { table: string; payload: unknown }
let recorded: Recorded[] = [];

// Includes one keg-type row so the "non-can container_id" test exercises a real filter,
// not a stub that returns the same fixture regardless of which id was requested.
const PACKAGING_ITEMS = [
  { id: "container-1", type: "can" },
  { id: "keg-container", type: "keg" },
];
const EXISTING_VARIATIONS = [
  {
    container_id: "container-1",
    format: "loose",
    lid_id: "lid-1",
    paktech_id: null,
    tray_id: null,
    label_id: "label-1",
    partner_id: null,
  },
];
const INSERTED_ROWS = [{ id: "new-1", name: "inserted" }];

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
    select: () => ({
      in: (_field: string, ids: string[]) => Promise.resolve({ data: EXISTING_VARIATIONS.filter((v) => ids.includes(v.container_id)), error: null }),
    }),
    insert: (payload: unknown) => {
      recorded.push({ table: "packaging_variations", payload });
      return { select: () => Promise.resolve({ data: INSERTED_ROWS, error: null }) };
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

const VALID_ITEM = {
  container_id: "container-1",
  format: "4-pack",
  lid_id: "lid-1",
  paktech_id: "paktech-1",
  tray_id: null,
  label_id: "label-1",
  partner_id: null,
  name: "Test Beer - 16oz Labeled Can 4-Pack",
};

describe("POST /api/production/packaging-variations/bulk", () => {
  beforeEach(() => {
    recorded = [];
    vi.mocked(requireRole).mockResolvedValue(undefined as never);
  });

  it("rejects an empty items array", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [] }));
    expect(res.status).toBe(400);
  });

  it("returns whatever requireRole throws (role gate)", async () => {
    vi.mocked(requireRole).mockRejectedValueOnce(new Response(null, { status: 403 }) as never);
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_ITEM] }));
    expect(res.status).toBe(403);
  });

  it("rejects the whole request when a container_id is not type can", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [{ ...VALID_ITEM, container_id: "keg-container" }] }));
    expect(res.status).toBe(400);
  });

  it("skips a row that fails validateFormat instead of failing the batch", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({
      items: [{ ...VALID_ITEM, paktech_id: null }], // 4-pack requires paktech_id
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([
      { name: VALID_ITEM.name, reason: 'format "4-pack" requires paktech_id' },
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
        name: "Duplicate of existing loose variation",
      }],
    }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.created).toEqual([]);
    expect(json.skipped).toEqual([{ name: "Duplicate of existing loose variation", reason: "already exists" }]);
  });

  it("inserts valid, non-duplicate rows in one call and returns 201", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ items: [VALID_ITEM] }));
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.created).toEqual(INSERTED_ROWS);
    expect(json.skipped).toEqual([]);
    const insertCall = recorded.find((r) => r.table === "packaging_variations");
    expect(insertCall).toBeTruthy();
    expect((insertCall!.payload as unknown[]).length).toBe(1);
  });
});
