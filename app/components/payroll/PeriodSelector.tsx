"use client";

import { useRouter } from "next/navigation";
import type { PayPeriod } from "@/lib/payroll/types";

interface Props {
  periods: PayPeriod[];
  currentId: string;
  basePath: string; // "/taproom/payroll" or "/finance/payroll"
}

export function PeriodSelector({ periods, currentId, basePath }: Props) {
  const router = useRouter();

  return (
    <select
      value={currentId}
      onChange={(e) => router.push(`${basePath}/${e.target.value}`)}
      className="inp-sm"
    >
      {periods.map((p) => (
        <option key={p.id} value={p.id}>
          {p.start_date} – {p.end_date}{p.status === "locked" ? " (Locked)" : " (Open)"}
        </option>
      ))}
    </select>
  );
}
