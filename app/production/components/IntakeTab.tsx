"use client";

import { useState, useEffect } from "react";
import { Recipe, BatchTransfer, Equipment, BrewBatch, ContractBrewingPartner } from "../types";
import TaproomTab from "./intake/TaproomTab";
import DistributionTab from "./intake/DistributionTab";
import ContractBrewingTab from "./intake/ContractBrewingTab";
import SafetyStockTab from "./intake/SafetyStockTab";

type IntakeSubtab = "taproom" | "distribution" | "contract" | "safety" | "demand" | "scheduler";

const SUBTABS: { key: IntakeSubtab; label: string; description: string }[] = [
  { key: "taproom",      label: "Taproom",          description: "Live taproom inventory from Square with threshold forecasting." },
  { key: "distribution", label: "Distribution",     description: "Committed purchase allocations by style and packaging." },
  { key: "contract",     label: "Contract Brewing", description: "Contract brewing requests from partners." },
  { key: "safety",       label: "Safety Stock",     description: "Cold-storage inventory and safety stock floors." },
  { key: "demand",       label: "Demand Calendar",  description: "Aggregated demand schedule by style and packaging, week over week." },
  { key: "scheduler",    label: "Batch Scheduler",  description: "Recommended batches based on demand and equipment availability." },
];

export default function IntakeTab({
  recipes, transfers, tanks, batches,
}: {
  recipes: Recipe[];
  transfers: BatchTransfer[];
  tanks: Equipment[];
  batches: BrewBatch[];
}) {
  const [sub, setSub] = useState<IntakeSubtab>("taproom");
  const [partners, setPartners] = useState<ContractBrewingPartner[]>([]);
  const meta = SUBTABS.find((s) => s.key === sub)!;

  useEffect(() => {
    (async () => {
      const r = await fetch("/api/partners/contract-brewing");
      if (r.ok) setPartners(await r.json());
    })();
  }, []);

  return (
    <>
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">Intake</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Demand planning across taproom, distribution, and contract brewing</p>
      </div>

      <div className="flex gap-1 mb-6 border-b border-zinc-800">
        {SUBTABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setSub(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              sub === key
                ? "border-amber-500 text-zinc-100"
                : "border-transparent text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {sub === "taproom"      && <TaproomTab recipes={recipes} />}
      {sub === "distribution" && <DistributionTab recipes={recipes} partners={partners} />}
      {sub === "contract"     && <ContractBrewingTab recipes={recipes} partners={partners} />}
      {sub === "safety"       && <SafetyStockTab recipes={recipes} transfers={transfers} tanks={tanks} batches={batches} />}

      {(sub === "demand" || sub === "scheduler") && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="text-zinc-700 text-4xl mb-4">○</div>
          <p className="text-sm text-zinc-500 font-medium">{meta.label}</p>
          <p className="text-xs text-zinc-600 mt-1 max-w-sm">{meta.description} (Coming in Phase 2.)</p>
        </div>
      )}
    </>
  );
}
