"use client";

/**
 * "Where does this beer's share come from?" — the one radio list shared by the
 * Ship modal (over-delivery and new-booking cases) and the Partner Ledger's
 * re-home modal. Plain option labels; the reason an option is greyed out lives
 * in its tooltip, not inline.
 */

import type { HomeSource } from "@/lib/production/rehome";

export function homeSourceKey(h: HomeSource): string {
  return h.kind === "unallocated" ? "unallocated" : (h.allocationId ?? "");
}

function optionLabel(h: HomeSource): string {
  if (h.kind === "unallocated") return "Unassigned beer";
  if (h.kind === "self") return "This deal's own unshipped share";
  if (h.partnerName) return `${h.partnerName}'s share`;
  if (h.channel === "taproom") return "Taproom's share";
  if (h.channel === "safety_stock") return "Safety stock";
  return h.channel ?? "";
}

function disabledReason(h: HomeSource, enough: boolean): string | null {
  if (h.requires === "refund") return "Deposit already paid on this share — refund part of it in Batch Log first.";
  if (!enough) return "Not enough free beer here.";
  return null;
}

export default function HomeSourcePicker({ sources, bblNeeded, value, onChange, name }: {
  sources: HomeSource[];
  bblNeeded: number;
  value: string;
  onChange: (key: string) => void;
  name: string;
}) {
  if (sources.length === 0) return <p className="text-xs text-danger">Nothing on this batch can give up share.</p>;
  return (
    <div className="space-y-1">
      {sources.map((h) => {
        const key = homeSourceKey(h);
        const enough = h.freeBbl + 0.0001 >= bblNeeded;
        const reason = disabledReason(h, enough);
        return (
          <label key={key} title={reason ?? undefined}
            className={`flex items-center gap-2 text-xs ${reason ? "text-faint" : "text-body cursor-pointer"}`}>
            <input type="radio" name={name} disabled={!!reason} checked={value === key} onChange={() => onChange(key)} />
            <span>{optionLabel(h)}</span>
            <span className="text-faint tabular-nums">{h.freeBbl.toFixed(2)} bbl free</span>
            {h.requires === "regenerate_deposit" && !reason && (
              <span className="text-faint">· draft deposit invoice will be regenerated</span>
            )}
          </label>
        );
      })}
    </div>
  );
}
