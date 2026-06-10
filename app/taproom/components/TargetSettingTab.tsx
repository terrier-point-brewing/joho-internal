"use client";

import { useEffect, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import { useUserRole } from "@/lib/hooks/useUserRole";
import { queryKeys } from "@/lib/query-keys";

type Tier = "baseline" | "recovery" | "target" | "stretch";

type Target = {
  id: string;
  year: number;
  quarter: number;
  tier: Tier;
  target_cents: number;
};

const TIERS: { value: Tier; label: string; color: string; description: string }[] = [
  { value: "baseline", label: "Baseline", color: "text-zinc-400",  description: "Minimum acceptable" },
  { value: "recovery", label: "Recovery", color: "text-blue-400",  description: "Recovering to normal" },
  { value: "target",   label: "Target",   color: "text-amber-400", description: "Primary goal" },
  { value: "stretch",  label: "Stretch",  color: "text-green-400", description: "Ambitious upside" },
];

// Shared column header block (module-scoped so it isn't recreated each render).
function ColHeaders() {
  return (
    <div className="grid grid-cols-[80px_1fr_1fr_1fr_1fr] border-b border-zinc-800 bg-zinc-900/60">
      <div className="px-4 py-3" />
      {TIERS.map((t) => (
        <div key={t.value} className="px-3 py-3 text-center">
          <div className={`text-sm font-semibold ${t.color}`}>{t.label}</div>
          <div className="text-xs text-zinc-600 mt-0.5">{t.description}</div>
        </div>
      ))}
    </div>
  );
}

// Grid state: { [quarter]: { [tier]: string } }  — stores comma-formatted display strings
type GridState = Record<number, Record<Tier, string>>;

/** cents → "150,000" (no $ — $ prefix shown separately in the input) */
function centsToInput(cents: number): string {
  return Math.round(cents / 100).toLocaleString("en-US");
}

/** "150,000" or "150000" → cents, or null if invalid */
function inputToCents(s: string): number | null {
  const n = parseFloat(s.replace(/[^0-9.]/g, ""));
  return isNaN(n) || n < 0 ? null : Math.round(n * 100);
}

/** Format a raw keypress value → comma-formatted display string */
function formatWithCommas(raw: string): string {
  const stripped = raw.replace(/,/g, "");
  if (!stripped) return "";
  const n = parseInt(stripped, 10);
  return isNaN(n) ? stripped : n.toLocaleString("en-US");
}

function currency(cents: number) {
  return (cents / 100).toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 0, maximumFractionDigits: 0,
  });
}

function emptyGrid(): GridState {
  const g: GridState = {};
  for (let q = 1; q <= 4; q++) {
    g[q] = { baseline: "", recovery: "", target: "", stretch: "" };
  }
  return g;
}

const inputCls =
  "w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-sm text-zinc-100 " +
  "placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-amber-500 focus:border-amber-500 " +
  "text-right font-mono transition-colors";

const selectCls =
  "bg-zinc-800 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 " +
  "focus:outline-none focus:ring-2 focus:ring-amber-500";

// ---------------------------------------------------------------------------

export default function TargetSettingTab() {
  const currentYear = new Date().getFullYear();
  const { role } = useUserRole();
  const isAdmin = role === "admin";

  const qc = useQueryClient();
  const { data: targets = [], isLoading: loading } = useQuery({
    queryKey: queryKeys.taproom.targets(),
    queryFn: () => fetchJson<Target[]>("/api/targets"),
  });
  const refreshTargets = () => qc.invalidateQueries({ queryKey: queryKeys.taproom.targets() });

  const [mode,    setMode]    = useState<"view" | "edit">("view");
  const [year,    setYear]    = useState(currentYear);
  const [grid,    setGrid]    = useState<GridState>(emptyGrid());
  const [dirty,   setDirty]   = useState<Set<string>>(new Set());
  const [saving,  setSaving]  = useState(false);
  const [saved,   setSaved]   = useState(false);

  const populatedYearRef = useRef<number | null>(null);

  // Re-populate grid from DB whenever year or targets change.
  // This is a pure derivation of server data into editable local state — not a
  // fire-and-forget effect — so the setState is intentional here.
  useEffect(() => {
    if (populatedYearRef.current === year) return;
    populatedYearRef.current = year;
    const g = emptyGrid();
    for (const t of targets) {
      if (t.year === year) g[t.quarter][t.tier] = centsToInput(t.target_cents);
    }
    setGrid(g);
    setDirty(new Set());
  }, [year, targets]);

  function handleCell(quarter: number, tier: Tier, value: string) {
    setGrid((prev) => ({
      ...prev,
      [quarter]: { ...prev[quarter], [tier]: formatWithCommas(value) },
    }));
    setDirty((prev) => new Set(prev).add(`${quarter}-${tier}`));
  }

  function handleEnterEdit() {
    // Seed grid from current saved values before entering edit mode
    populatedYearRef.current = null;
    const g = emptyGrid();
    for (const t of targets) {
      if (t.year === year) g[t.quarter][t.tier] = centsToInput(t.target_cents);
    }
    setGrid(g);
    setDirty(new Set());
    setMode("edit");
  }

  function handleCancel() {
    setMode("view");
    setDirty(new Set());
  }

  async function handleSave() {
    const saves: { quarter: number; tier: Tier; target_cents: number }[] = [];
    for (let q = 1; q <= 4; q++) {
      for (const { value: tier } of TIERS) {
        const raw   = grid[q][tier];
        const cents = inputToCents(raw);
        if (cents !== null && raw.trim() !== "") {
          saves.push({ quarter: q, tier, target_cents: cents });
        }
      }
    }
    if (saves.length === 0) { setMode("view"); return; }

    setSaving(true);
    await Promise.allSettled(
      saves.map((s) =>
        fetch("/api/targets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ year, ...s }),
        })
      )
    );
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
    setDirty(new Set());
    populatedYearRef.current = null;
    await refreshTargets();
    setMode("view");
  }

  // Saved values for current year, indexed for easy lookup
  const savedValues: Record<number, Record<Tier, number | null>> = {};
  for (let q = 1; q <= 4; q++) {
    savedValues[q] = { baseline: null, recovery: null, target: null, stretch: null };
    for (const { value: tier } of TIERS) {
      const t = targets.find((x) => x.year === year && x.quarter === q && x.tier === tier);
      if (t) savedValues[q][tier] = t.target_cents;
    }
  }

  const hasAnyForYear = targets.some((t) => t.year === year);
  const hasChanges    = [...dirty].some((k) => {
    const [q, tier] = k.split("-");
    return inputToCents(grid[Number(q)][tier as Tier]) !== null;
  });

  // ---------------------------------------------------------------------------
  // VIEW MODE
  // ---------------------------------------------------------------------------
  if (mode === "view") {
    return (
      <div className="max-w-4xl space-y-6">
        {/* Year tabs + Edit button inline */}
        <div className="flex items-center gap-2">
          {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
            <button
              key={y}
              onClick={() => { populatedYearRef.current = null; setYear(y); }}
              className={`px-4 py-1.5 rounded text-sm font-medium border transition-colors ${
                year === y
                  ? "border-amber-600 bg-amber-900/20 text-amber-300"
                  : "border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500"
              }`}
            >
              {y}
            </button>
          ))}
          {isAdmin && (
            <>
              <div className="w-px h-5 bg-zinc-700 mx-1" />
              <button
                onClick={handleEnterEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-zinc-700 text-sm text-zinc-400 hover:text-zinc-100 hover:border-zinc-500 transition-colors"
              >
                <span>✎</span> Edit
              </button>
            </>
          )}
        </div>

        {loading ? (
          <p className="text-sm text-zinc-500">Loading…</p>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden overflow-x-auto">
            <div className="min-w-[480px]">
            <ColHeaders />
            {[1, 2, 3, 4].map((q) => (
              <div
                key={q}
                className="grid grid-cols-[80px_1fr_1fr_1fr_1fr] border-b border-zinc-800 last:border-0"
              >
                <div className="px-4 py-4 flex items-center">
                  <span className="text-sm font-semibold text-zinc-200">Q{q}</span>
                </div>
                {TIERS.map(({ value: tier }) => {
                  const val = savedValues[q][tier];
                  return (
                    <div key={tier} className="px-3 py-4 text-right">
                      {val !== null ? (
                        <span className="text-sm font-mono text-zinc-100">{currency(val)}</span>
                      ) : (
                        <span className="text-sm text-zinc-700">—</span>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {!hasAnyForYear && (
              <div className="px-4 py-6 text-center text-sm text-zinc-600">
                No targets set for {year}.{" "}
                {isAdmin && (
                  <button onClick={handleEnterEdit} className="text-amber-500 hover:text-amber-400 underline">
                    Add some
                  </button>
                )}
              </div>
            )}
            </div>
          </div>
        )}

        {/* Other years summary — compact */}
        <AllYearsSummary targets={targets} activeYear={year} onSelectYear={(y) => { populatedYearRef.current = null; setYear(y); }} />
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // EDIT MODE
  // ---------------------------------------------------------------------------
  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-xs text-zinc-600">Editing {year} · blank cells are skipped on save</p>
        <div className="flex items-center gap-3">
          <button onClick={handleCancel} className="px-4 py-2 rounded border border-zinc-700 text-sm text-zinc-400 hover:text-zinc-200 transition-colors">
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white text-sm font-medium px-5 py-2 rounded transition-colors"
          >
            {saving ? "Saving…" : saved ? "✓ Saved" : "Save Changes"}
          </button>
        </div>
      </div>

      {/* Year selector in edit mode */}
      <div className="flex items-center gap-3">
        <span className="text-sm text-zinc-500">Year</span>
        <select
          value={year}
          onChange={(e) => { populatedYearRef.current = null; setYear(Number(e.target.value)); }}
          className={selectCls}
        >
          {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden overflow-x-auto">
        <div className="min-w-[480px]">
        <ColHeaders />
        {[1, 2, 3, 4].map((q) => (
          <div
            key={q}
            className="grid grid-cols-[80px_1fr_1fr_1fr_1fr] border-b border-zinc-800 last:border-0 hover:bg-zinc-800/20 transition-colors"
          >
            <div className="px-4 py-3 flex items-center">
              <span className="text-sm font-semibold text-zinc-200">Q{q}</span>
            </div>
            {TIERS.map(({ value: tier }) => {
              const isDirty     = dirty.has(`${q}-${tier}`);
              const savedVal    = savedValues[q][tier];
              const inputVal    = grid[q][tier];
              const parsedCents = inputToCents(inputVal);
              const unchanged   = savedVal !== null && parsedCents !== null && parsedCents === savedVal;

              return (
                <div key={tier} className="px-3 py-2.5">
                  <div className={`relative ${isDirty && !unchanged ? "ring-1 ring-amber-700/50 rounded" : ""}`}>
                    <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-500 text-sm pointer-events-none select-none">
                      $
                    </span>
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="—"
                      value={inputVal}
                      onChange={(e) => handleCell(q, tier, e.target.value)}
                      className={`${inputCls} pl-6`}
                    />
                  </div>
                  {/* Show change preview */}
                  {isDirty && !unchanged && parsedCents !== null && savedVal !== null && (
                    <div className="text-xs text-zinc-600 text-right mt-0.5 pr-0.5">
                      was {currency(savedVal)}
                    </div>
                  )}
                  {isDirty && !unchanged && parsedCents !== null && savedVal === null && (
                    <div className="text-xs text-zinc-600 text-right mt-0.5 pr-0.5">new</div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
        </div>
      </div>

      {!hasChanges && (
        <p className="text-xs text-zinc-600">No changes yet — edit cells above then save.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Compact all-years summary (view mode only)
// ---------------------------------------------------------------------------

function AllYearsSummary({
  targets,
  activeYear,
  onSelectYear,
}: {
  targets: Target[];
  activeYear: number;
  onSelectYear: (y: number) => void;
}) {
  const otherYears = [...new Set(targets.map((t) => t.year))]
    .filter((y) => y !== activeYear)
    .sort((a, b) => b - a);

  if (otherYears.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-zinc-500 uppercase tracking-wide">Other years</p>
      {otherYears.map((y) => {
        const yt = targets.filter((t) => t.year === y);
        const hasData = yt.length > 0;
        return (
          <div key={y} className="bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-medium text-zinc-300">{y}</span>
            {hasData ? (
              <span className="text-xs text-zinc-500">{yt.length} target{yt.length !== 1 ? "s" : ""} set</span>
            ) : (
              <span className="text-xs text-zinc-700">No targets</span>
            )}
            <button
              onClick={() => onSelectYear(y)}
              className="text-xs text-amber-500 hover:text-amber-400"
            >
              View →
            </button>
          </div>
        );
      })}
    </div>
  );
}
