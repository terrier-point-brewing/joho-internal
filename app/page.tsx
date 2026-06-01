"use client";

import { useState } from "react";
import CocktailSalesReport from "./components/CocktailSalesReport";
import KegSalesReport from "./components/KegSalesReport";
import TaproomModelReport from "./components/TaproomModelReport";

const REPORTS = [
  { id: "cocktail-sales",  label: "Cocktail Sales" },
  { id: "keg-sales",       label: "Keg Sales"      },
  { id: "taproom-model",   label: "Taproom Model Sales" },
] as const;

type ReportId = (typeof REPORTS)[number]["id"];

export default function Home() {
  const [activeReport, setActiveReport] = useState<ReportId>("cocktail-sales");

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <h1 className="text-xl font-semibold text-gray-900">TPB Square Reports</h1>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-6 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-800">Report</label>
          <select
            value={activeReport}
            onChange={(e) => setActiveReport(e.target.value as ReportId)}
            className="border border-gray-300 rounded-md px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {REPORTS.map((r) => (
              <option key={r.id} value={r.id}>{r.label}</option>
            ))}
          </select>
        </div>

        <h2 className="text-lg font-medium text-gray-800 mb-5">
          {REPORTS.find((r) => r.id === activeReport)?.label}
        </h2>

        {activeReport === "cocktail-sales" && <CocktailSalesReport />}
        {activeReport === "keg-sales"      && <KegSalesReport />}
        {activeReport === "taproom-model"  && <TaproomModelReport />}
      </main>
    </div>
  );
}
