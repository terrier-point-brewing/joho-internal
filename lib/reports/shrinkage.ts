/**
 * Shrinkage Report
 *
 * Tracks physical inventory count changes for draft beer and liquor.
 * Shrinkage is identified when the recorded quantity DROPS between two
 * consecutive physical counts of the same item (no restock in between).
 *
 * The unit of measurement Square uses is fl oz for both partially-consumed
 * kegs and open bottles:
 *   - Draft keg:  up to 660 fl oz (1/6 BBL), 992 fl oz (1/4 BBL), 1984 fl oz (1/2 BBL)
 *   - Liquor:     25.4 fl oz (750ml), 33.8 fl oz (1L), 59.2 fl oz (1.75L)
 *
 * Shrinkage % per period = (qty_start - qty_end) / qty_start × 100
 * A positive number means inventory depleted faster than zero-accounting expects.
 */

import type { CatalogItem } from "@/types/square";
import type { PhysicalCount } from "@/lib/square/inventory";
import { CATEGORY_IDS } from "@/lib/constants/categories";

// ---------------------------------------------------------------------------
// Item classification
// ---------------------------------------------------------------------------

export type ShrinkageCategory = "DRAFT" | "LIQUOR";

const DRAFT_CATEGORY_IDS = new Set([...CATEGORY_IDS.DRAFT]);

const LIQUOR_CATEGORY_IDS = new Set([
  ...CATEGORY_IDS.BOURBON, ...CATEGORY_IDS.WHISKEY, ...CATEGORY_IDS.TEQUILA,
  ...CATEGORY_IDS.RUM,     ...CATEGORY_IDS.VODKA,   ...CATEGORY_IDS.GIN,
]);

interface VarMeta {
  itemName:     string;
  variationName: string;
  category:     ShrinkageCategory;
}

function buildVarMeta(items: CatalogItem[]): Map<string, VarMeta> {
  const map = new Map<string, VarMeta>();
  for (const item of items) {
    const rc = item.item_data.reporting_category?.id ?? "";
    let category: ShrinkageCategory | null = null;
    if (DRAFT_CATEGORY_IDS.has(rc))   category = "DRAFT";
    if (LIQUOR_CATEGORY_IDS.has(rc))  category = "LIQUOR";
    if (!category) continue;

    for (const v of item.item_data.variations ?? []) {
      map.set(v.id, {
        itemName:      item.item_data.name,
        variationName: v.item_variation_data.name,
        category,
      });
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// ISO week key  e.g. "2026-W21"
// ---------------------------------------------------------------------------

function isoWeek(dateStr: string): string {
  const d = new Date(dateStr);
  // Thursday in current week → ISO week belongs to that year
  const thu = new Date(d);
  thu.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const year = thu.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const week = Math.ceil((((thu.getTime() - jan1.getTime()) / 86400000) + jan1.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface CountEvent {
  date:           string;   // ISO date YYYY-MM-DD
  week:           string;   // ISO week "2026-W21"
  qty:            number;   // fl oz at time of count
  shrinkagePct:   number | null; // null for first count or restock events
}

export interface ShrinkageItem {
  variationId:   string;
  itemName:      string;
  variationName: string;
  category:      ShrinkageCategory;
  counts:        CountEvent[];       // sorted chronologically
  latestQty:     number;
  peakQty:       number;             // highest count seen (proxy for "full")
  latestPctRemaining: number | null; // latestQty / peakQty * 100
  avgShrinkagePct: number | null;    // average of non-null shrinkagePct values
}

export interface ShrinkageChartPoint {
  week:   string;
  [itemKey: string]: number | string | null;
}

export interface ShrinkageResult {
  draft:     ShrinkageItem[];
  liquor:    ShrinkageItem[];
  chartData: ShrinkageChartPoint[];  // for Recharts LineChart
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

export function buildShrinkageReport(
  counts: PhysicalCount[],
  items:  CatalogItem[]
): ShrinkageResult {
  const meta = buildVarMeta(items);

  // Only keep fl oz-tracked items (fractional or known fl oz values)
  // A physical count is fl oz-tracked if qty has a decimal OR if the item
  // is in a draft/liquor category AND the qty is a known fl oz standard
  // (kegs: 660, 992, 1984; spirits: multiples of 25.4 or 33.8).
  // We keep ALL counts for matched categories and let the UI decide what to surface.
  const byVar = new Map<string, { meta: VarMeta; counts: PhysicalCount[] }>();

  for (const pc of counts) {
    const m = meta.get(pc.catalog_object_id);
    if (!m) continue;

    const qty = parseFloat(pc.quantity);
    if (isNaN(qty)) continue;

    let bucket = byVar.get(pc.catalog_object_id);
    if (!bucket) {
      bucket = { meta: m, counts: [] };
      byVar.set(pc.catalog_object_id, bucket);
    }
    bucket.counts.push(pc);
  }

  // Build ShrinkageItem per variation
  const shrinkageItems: ShrinkageItem[] = [];

  for (const [varId, { meta: m, counts: rawCounts }] of byVar) {
    // Sort chronologically
    const sorted = [...rawCounts].sort((a, b) =>
      a.occurred_at.localeCompare(b.occurred_at)
    );

    let peakQty = 0;
    const events: CountEvent[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const qty  = parseFloat(sorted[i].quantity);
      const date = sorted[i].occurred_at.slice(0, 10);
      const week = isoWeek(sorted[i].occurred_at);

      if (qty > peakQty) peakQty = qty;

      let shrinkagePct: number | null = null;
      if (i > 0) {
        const prevQty = parseFloat(sorted[i - 1].quantity);
        if (prevQty > 0 && qty < prevQty) {
          // Decrease: consumption / shrinkage occurred
          shrinkagePct = ((prevQty - qty) / prevQty) * 100;
        }
        // If qty >= prevQty, inventory increased (restock) → shrinkagePct stays null
      }

      events.push({ date, week, qty, shrinkagePct });
    }

    const nonNullPcts = events.map(e => e.shrinkagePct).filter((v): v is number => v !== null);
    const avgShrinkagePct = nonNullPcts.length > 0
      ? nonNullPcts.reduce((a, b) => a + b, 0) / nonNullPcts.length
      : null;

    const latestQty = parseFloat(sorted[sorted.length - 1].quantity);

    shrinkageItems.push({
      variationId: varId,
      itemName:     m.itemName,
      variationName: m.variationName,
      category:     m.category,
      counts:       events,
      latestQty,
      peakQty,
      latestPctRemaining: peakQty > 0 ? (latestQty / peakQty) * 100 : null,
      avgShrinkagePct,
    });
  }

  const draft  = shrinkageItems.filter(i => i.category === "DRAFT").sort((a, b) => a.itemName.localeCompare(b.itemName));
  const liquor = shrinkageItems.filter(i => i.category === "LIQUOR").sort((a, b) => a.itemName.localeCompare(b.itemName));

  // ---------------------------------------------------------------------------
  // Build chart data — one row per ISO week, one column per item
  // ---------------------------------------------------------------------------
  const allWeeks = new Set<string>();
  for (const item of shrinkageItems) {
    for (const e of item.counts) allWeeks.add(e.week);
  }

  const sortedWeeks = [...allWeeks].sort();

  // For each week, find the last count's shrinkagePct for each item
  const chartData: ShrinkageChartPoint[] = sortedWeeks.map(week => {
    const point: ShrinkageChartPoint = { week };
    for (const item of shrinkageItems) {
      const key = item.itemName;
      const weekCounts = item.counts.filter(e => e.week === week);
      if (weekCounts.length > 0) {
        // Use the last count in the week; null if it was a restock (no shrinkage)
        const last = weekCounts[weekCounts.length - 1];
        point[key] = last.shrinkagePct !== null ? parseFloat(last.shrinkagePct.toFixed(1)) : null;
      } else {
        point[key] = null;
      }
    }
    return point;
  });

  return { draft, liquor, chartData };
}
