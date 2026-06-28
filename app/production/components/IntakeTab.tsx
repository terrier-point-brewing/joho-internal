"use client";

import { useState } from "react";
import TaproomTab      from "./intake/TaproomTab";
import CommitmentsTab  from "./intake/CommitmentsTab";
import SafetyStockTab  from "./intake/SafetyStockTab";
import DemandCalendarTab from "./intake/DemandCalendarTab";
import BatchSchedulerTab from "./intake/BatchSchedulerTab";
import { useRecipesQuery, useTransfersQuery, useEquipmentQuery, useBatchesQuery, useContractPartnersQuery } from "../hooks/queries";

type IntakeSubtab = "taproom" | "commitments" | "safety" | "demand" | "scheduler";

const SUBTABS: { key: IntakeSubtab; label: string }[] = [
  { key: "taproom",     label: "Taproom" },
  { key: "commitments", label: "Commitments" },
  { key: "safety",      label: "Safety Stock" },
  { key: "demand",      label: "Demand Calendar" },
  { key: "scheduler",   label: "Batch Scheduler" },
];

export default function IntakeTab() {
  const [sub, setSub] = useState<IntakeSubtab>("taproom");
  const { data: recipes = [] }  = useRecipesQuery();
  const { data: transfers = [] } = useTransfersQuery();
  const { data: tanks = [] }    = useEquipmentQuery();
  const { data: batches = [] }  = useBatchesQuery();
  const { data: partners = [] } = useContractPartnersQuery();

  return (
    <>
      <div className="mt-4 mb-4">
        <h2 className="text-base font-medium text-zinc-100">Intake</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Demand planning across taproom, distribution, and contract brewing</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-zinc-800 sticky top-[5.25rem] md:static z-30 bg-zinc-950/95 -mx-4 sm:mx-0 px-4 sm:px-0 overflow-x-auto overflow-y-hidden scrollbar-none">
        {SUBTABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
              sub === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === "taproom"     && <TaproomTab recipes={recipes} />}
      {sub === "commitments" && <CommitmentsTab recipes={recipes} partners={partners} />}
      {sub === "safety"      && <SafetyStockTab recipes={recipes} transfers={transfers} tanks={tanks} batches={batches} />}
      {sub === "demand"      && <DemandCalendarTab />}
      {sub === "scheduler"   && <BatchSchedulerTab recipes={recipes} tanks={tanks} partners={partners} />}
    </>
  );
}
