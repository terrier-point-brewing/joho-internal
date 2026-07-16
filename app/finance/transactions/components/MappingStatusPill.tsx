import { mappingState } from "@/lib/finance/mappingStatus";

/**
 * Compact "✓ mapped / N∕M / unmapped" indicator shared by every Transactions
 * subtab. Renders nothing for records with no children (matching the prior
 * hand-rolled behaviour on the POS Transactions page).
 */
export default function MappingStatusPill({
  mapped,
  total,
  accepted = false,
}: {
  mapped: number;
  total: number;
  accepted?: boolean;
}) {
  const state = mappingState(mapped, total, accepted);
  if (state === "empty") return null;
  if (state === "mapped") return <span className="text-[10px] text-success">✓ mapped</span>;
  if (state === "partial") return <span className="text-[10px] text-accent-emphasis">{mapped}/{total}</span>;
  if (state === "accepted") return <span className="text-[10px] text-info">✓ accepted</span>;
  return <span className="text-[10px] text-faint">unmapped</span>;
}
