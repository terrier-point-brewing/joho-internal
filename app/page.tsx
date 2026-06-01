"use client";

import { useState } from "react";
import CocktailSalesReport from "./components/CocktailSalesReport";
import KegSalesReport from "./components/KegSalesReport";
import TaproomModelReport from "./components/TaproomModelReport";
import GiftCardReport from "./components/GiftCardReport";

const REPORTS = [
  { id: "cocktail-sales", label: "Cocktail Sales"        },
  { id: "keg-sales",      label: "Keg Sales"             },
  { id: "taproom-model",  label: "Taproom Model Sales"   },
  { id: "gift-cards",     label: "Gift Card Sales"       },
] as const;

type ReportId = (typeof REPORTS)[number]["id"];

export default function Home() {
  const [activeReport, setActiveReport] = useState<ReportId>("cocktail-sales");

  return (
    <div className="min-h-screen bg-zinc-950">
      <header className="bg-zinc-900 border-b border-zinc-700 px-6 py-4">
        <h1 className="text-xl font-semibold text-zinc-100">TPB Square Reports</h1>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <label className="text-sm font-medium text-zinc-300">Report</label>
          <select
            value={activeReport}
            onChange={(e) => setActiveReport(e.target.value as ReportId)}
            className="bg-zinc-800 border border-zinc-600 rounded-md px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {REPORTS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>

        <h2 className="text-lg font-medium text-zinc-100 mb-5">
          {REPORTS.find((r) => r.id === activeReport)?.label}
        </h2>

        {activeReport === "cocktail-sales" && <CocktailSalesReport />}
        {activeReport === "keg-sales"      && <KegSalesReport />}
        {activeReport === "taproom-model"  && <TaproomModelReport />}
        {activeReport === "gift-cards"     && <GiftCardReport />}
      </main>
    </div>
  );
}
