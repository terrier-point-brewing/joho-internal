"use client";

import { useState } from "react";

type IntakeSubtab = "requests" | "demand" | "scheduler";

const SUBTABS: { key: IntakeSubtab; label: string; description: string }[] = [
  { key: "requests",  label: "Requests",  description: "Incoming production requests from taproom, distribution, and contract brewing clients." },
  { key: "demand",    label: "Demand",    description: "Demand forecasting and inventory targets by product." },
  { key: "scheduler", label: "Scheduler", description: "Auto-schedule production runs based on demand and available equipment capacity." },
];

export default function IntakeTab() {
  const [sub, setSub] = useState<IntakeSubtab>("requests");
  const meta = SUBTABS.find(s => s.key === sub)!;

  return (
    <>
      {/* Header */}
      <div className="mb-4">
        <h2 className="text-base font-medium text-zinc-100">Intake</h2>
        <p className="text-sm text-zinc-500 mt-0.5">Manage incoming production requests, demand forecasts, and auto-scheduling</p>
      </div>

      {/* Subtab bar */}
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

      {/* Placeholder content */}
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <div className="text-zinc-700 text-4xl mb-4">○</div>
        <p className="text-sm text-zinc-500 font-medium">{meta.label}</p>
        <p className="text-xs text-zinc-600 mt-1 max-w-sm">{meta.description}</p>
      </div>
    </>
  );
}
