// lib/production/packagingMaterials.ts
//
// Pure cost math for the contract-brewing "Packaging Materials" invoice line.
// Given the packaging components consumed by a set of same-recipe can
// transactions, sum their unit costs into integer cents. No Supabase — the
// caller resolves each variation's slots and hands them in. The per-format
// component-quantity logic mirrors getUnitsPerPackage / getPaktechUnitsPerPackage
// in packagingVariations.ts, but operates on already-fetched can_counts so we
// never issue an extra query per transaction.
import { dollarsToCents } from "@/lib/money";

export type MaterialRole = "container" | "lid" | "label" | "paktech" | "tray";

export interface MaterialComponent {
  role: MaterialRole;
  name: string;
  unitCostDollars: number | null; // packaging_items.unit_cost_usd
  canCount: number | null; // packaging_items.can_count (paktech/tray)
}

export interface MaterialTxnInput {
  format: string; // 'loose' | '4-pack' | '6-pack' | 'case'
  packages: number; // export_transactions.quantity
  unitsPerPackage: number; // export_transactions.units_per_package
  components: MaterialComponent[]; // only populated slots
  /** Literal variation shipped (export_transactions.variant_label). Display only. */
  label?: string;
  /**
   * Canning packaging loss %, inherited from the run that filled these cans.
   * Applies ONLY to the per-can components (container/lid/label) — a spoiled can
   * takes its lid and label with it, but paktechs and trays are consumed per
   * package and are unaffected. Omit or 0 for kegs and for runs with no loss.
   */
  lossPct?: number;
}

/** Grows a per-can quantity by the run's loss %, rounded to whole units. */
export function applyPackagingLoss(quantity: number, lossPct: number | undefined): number {
  if (!lossPct) return quantity;
  return Math.round(quantity * (1 + lossPct / 100));
}

/** Components a canning loss % applies to. */
const LOSS_BEARING_ROLES: ReadonlySet<MaterialRole> = new Set<MaterialRole>(["container", "lid", "label"]);

// ── Breakdown types ─────────────────────────────────────────────────────────
// The same math computeMaterialCost sums, but retaining every intermediate so
// the invoice modal can show the user how a Packaging Materials line was
// derived. Display-only — never feed these back into pricing.

export interface MaterialComponentBreakdown {
  role: MaterialRole;
  name: string;
  unitCostDollars: number | null;
  /** Whole units of this component consumed by the transaction. */
  quantity: number;
  /** quantity × unit cost, in integer cents. 0 when the unit cost is unset. */
  extendedCents: number;
  /** True when the component is consumed but has no unit cost (billed $0). */
  missingCost: boolean;
}

export interface MaterialTxnBreakdown {
  label: string | null;
  format: string;
  packages: number;
  unitsPerPackage: number;
  components: MaterialComponentBreakdown[];
  subtotalCents: number;
}

export interface MaterialCostBreakdown {
  transactions: MaterialTxnBreakdown[];
  totalCents: number;
  missingCostNames: string[];
}

// Paktech bundles consumed per package: 1 for a 4/6-pack, cansPerCase/cansPerPaktech
// for a case, 0 for loose (or if no paktech slot). Mirrors getPaktechUnitsPerPackage.
function paktechPerPackage(format: string, components: MaterialComponent[]): number {
  const paktech = components.find((c) => c.role === "paktech");
  if (!paktech) return 0;
  if (format === "4-pack" || format === "6-pack") return 1;
  if (format === "case") {
    const tray = components.find((c) => c.role === "tray");
    const pc = paktech.canCount ?? 0;
    if (!pc || !tray?.canCount) return 0;
    return tray.canCount / pc;
  }
  return 0;
}

// Whole units of one component consumed across a transaction (rounded).
function consumedQty(role: MaterialRole, txn: MaterialTxnInput): number {
  const { format, packages, unitsPerPackage } = txn;
  if (LOSS_BEARING_ROLES.has(role)) {
    return applyPackagingLoss(Math.round(packages * (unitsPerPackage || 1)), txn.lossPct);
  }
  if (role === "paktech") return Math.round(packages * paktechPerPackage(format, txn.components));
  if (role === "tray") return Math.round(packages * (format === "case" ? 1 : 0));
  return 0;
}

/**
 * Full derivation of the Packaging Materials charge: every consumed component,
 * its per-unit cost, and its extended cost, grouped by transaction. Components
 * a transaction never consumes (qty 0 — e.g. a tray on a loose pack) are
 * omitted, matching what the total actually charges for.
 */
export function computeMaterialBreakdown(txns: MaterialTxnInput[]): MaterialCostBreakdown {
  const missing = new Set<string>();
  let totalCents = 0;
  const transactions: MaterialTxnBreakdown[] = [];

  for (const txn of txns) {
    const components: MaterialComponentBreakdown[] = [];
    let subtotalCents = 0;
    for (const comp of txn.components) {
      const qty = consumedQty(comp.role, txn);
      if (qty <= 0) continue;
      const missingCost = comp.unitCostDollars == null;
      if (missingCost) missing.add(comp.name);
      const extendedCents = missingCost ? 0 : qty * dollarsToCents(comp.unitCostDollars!);
      subtotalCents += extendedCents;
      components.push({
        role: comp.role,
        name: comp.name,
        unitCostDollars: comp.unitCostDollars,
        quantity: qty,
        extendedCents,
        missingCost,
      });
    }
    totalCents += subtotalCents;
    transactions.push({
      label: txn.label ?? null,
      format: txn.format,
      packages: txn.packages,
      unitsPerPackage: txn.unitsPerPackage,
      components,
      subtotalCents,
    });
  }

  return { transactions, totalCents, missingCostNames: [...missing] };
}

export function computeMaterialCost(txns: MaterialTxnInput[]): { totalCents: number; missingCostNames: string[] } {
  const { totalCents, missingCostNames } = computeMaterialBreakdown(txns);
  return { totalCents, missingCostNames };
}
