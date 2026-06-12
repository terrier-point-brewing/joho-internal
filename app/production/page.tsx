"use client";

import { Suspense, useState, useEffect } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useUserRole } from "@/lib/hooks/useUserRole";
import BatchLogTab    from "./components/BatchLogTab";
import RecipesTab     from "./components/RecipesTab";
import BrewStatusTab  from "./components/BrewStatusTab";
import GanttTab       from "./components/GanttTab";
import CalendarTab    from "./components/CalendarTab";
import InventoryTab   from "./components/InventoryTab";
import PartnersTab    from "./components/PartnersTab";
import ExportTab      from "./components/ExportTab";
import IntakeTab      from "./components/IntakeTab";

const PRODUCTION_TABS = [
  { key: "intake",    label: "Intake"    },
  { key: "brewing",   label: "Brewing"   },
  { key: "export",    label: "Export"    },
  { key: "recipes",   label: "Recipes"   },
  { key: "inventory", label: "Inventory" },
  { key: "partners",  label: "Partners"  },
] as const;

const BREWING_SUBTABS = [
  { key: "floorplan", label: "Floorplan"  },
  { key: "batch-log", label: "Batch Log"  },
  { key: "timeline",  label: "Timeline"   },
  { key: "calendar",  label: "Calendar"   },
] as const;

type BrewingSubtab = typeof BREWING_SUBTABS[number]["key"];

function ProductionContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const tab = searchParams.get("tab") ?? "intake";
  const [brewingSubtab, setBrewingSubtab] = useState<BrewingSubtab>("floorplan");
  const { role, loading } = useUserRole();

  useEffect(() => {
    if (!loading && role === "viewer") {
      router.replace("/taproom");
    }
  }, [role, loading, router]);

  if (loading || role === "viewer") return null;

  return (
    <main className="px-4 sm:px-6 py-4 sm:py-8">

      {/* Mobile-only tab nav — desktop uses the sidebar */}
      <div className="md:hidden flex border-b border-zinc-800 mb-4 -mx-4 overflow-x-auto scrollbar-none sticky top-11 z-40 bg-zinc-950/95">
        {PRODUCTION_TABS.map(({ key, label }) => (
          <Link
            key={key}
            href={`/production?tab=${key}`}
            className={`px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors border-b-2 -mb-px ${
              tab === key
                ? "text-amber-400 border-amber-500"
                : "text-zinc-500 border-transparent"
            }`}
          >
            {label}
          </Link>
        ))}
      </div>

      {tab === "intake" && <IntakeTab />}

      {tab === "brewing" && (
        <>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-medium text-zinc-100">Brewing</h2>
              <p className="text-sm text-zinc-500 mt-0.5">Floorplan, batch log, timeline, and calendar for all active and planned brews</p>
            </div>
          </div>
          <div className="overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0 sticky top-[5.25rem] md:static z-30 bg-zinc-950/95">
          <div className="flex gap-1 mb-0 md:mb-6 border-b border-zinc-800 pb-0 min-w-max sm:min-w-0">
            {BREWING_SUBTABS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setBrewingSubtab(key)}
                className={`px-4 py-2 text-sm font-medium rounded-t transition-colors -mb-px border-b-2 ${
                  brewingSubtab === key
                    ? "text-amber-400 border-amber-500 bg-amber-900/10"
                    : "text-zinc-500 border-transparent hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          </div>
          {brewingSubtab === "floorplan" && <BrewStatusTab />}
          {brewingSubtab === "batch-log" && <BatchLogTab />}
          {brewingSubtab === "timeline"  && <GanttTab />}
          {brewingSubtab === "calendar"  && <CalendarTab />}
        </>
      )}

      {tab === "export"    && <ExportTab />}
      {tab === "recipes"   && <RecipesTab />}
      {tab === "inventory" && <InventoryTab />}
      {tab === "partners"  && <PartnersTab />}

      <style>{`
        .inp {
          width: 100%;
          background: rgb(39 39 42);
          border: 1px solid rgb(63 63 70);
          border-radius: 0.375rem;
          padding: 0.375rem 0.5rem;
          font-size: 0.875rem;
          color: rgb(244 244 245);
          outline: none;
        }
        .inp:focus { border-color: rgb(161 161 170); }
        .inp option { background: rgb(39 39 42); }
      `}</style>
    </main>
  );
}

export default function ProductionPage() {
  return (
    <Suspense>
      <ProductionContent />
    </Suspense>
  );
}
