import { mappingState } from "@/lib/finance/mappingStatus";

/**
 * Compact "✓ mapped / N∕M / unmapped" indicator shared by every Transactions
 * subtab. Renders nothing for records with no children (matching the prior
 * hand-rolled behaviour on the POS Transactions page).
 */
export default function MappingStatusPill({ mapped, total }: { mapped: number; total: number }) {
  const state = mappingState(mapped, total);
  if (state === "empty") return null;
  if (state === "mapped") return <span className="text-[10px] text-success">✓ mapped</span>;
  if (state === "partial") return <span className="text-[10px] text-accent-emphasis">{mapped}/{total}</span>;
  return <span className="text-[10px] text-faint">unmapped</span>;
}
