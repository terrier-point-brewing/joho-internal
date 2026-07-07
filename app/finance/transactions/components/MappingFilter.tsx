"use client";
import type { MappingFilterValue } from "@/lib/finance/mappingStatus";

/** Shared "All / Fully / Partially / Unmapped" GL-mapping filter select. */
export default function MappingFilter({
  value,
  onChange,
}: {
  value: MappingFilterValue;
  onChange: (v: MappingFilterValue) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as MappingFilterValue)}
      className="inp-sm w-auto">
      <option value="all">All mappings</option>
      <option value="mapped">Fully mapped</option>
      <option value="partial">Partially mapped</option>
      <option value="unmapped">Unmapped</option>
    </select>
  );
}
