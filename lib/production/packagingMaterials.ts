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
  unitCostDollars: number | null; // packaging_items.unit_cost
  canCount: number | null; // packaging_items.can_count (paktech/tray)
}

export interface MaterialTxnInput {
  format: string; // 'loose' | '4-pack' | '6-pack' | 'case'
  packages: number; // export_transactions.quantity
  unitsPerPackage: number; // export_transactions.units_per_package
  components: MaterialComponent[]; // only populated slots
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
  if (role === "container" || role === "lid" || role === "label") {
    return Math.round(packages * (unitsPerPackage || 1));
  }
  if (role === "paktech") return Math.round(packages * paktechPerPackage(format, txn.components));
  if (role === "tray") return Math.round(packages * (format === "case" ? 1 : 0));
  return 0;
}

export function computeMaterialCost(txns: MaterialTxnInput[]): { totalCents: number; missingCostNames: string[] } {
  let totalCents = 0;
  const missing = new Set<string>();
  for (const txn of txns) {
    for (const comp of txn.components) {
      const qty = consumedQty(comp.role, txn);
      if (qty <= 0) continue;
      if (comp.unitCostDollars == null) {
        missing.add(comp.name);
        continue; // billed $0
      }
      totalCents += qty * dollarsToCents(comp.unitCostDollars);
    }
  }
  return { totalCents, missingCostNames: [...missing] };
}
