"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchJson } from "@/app/production/hooks/queries";
import Banner from "@/app/components/ui/Banner";
import type { FamilyMeasurement } from "@/lib/production/reconcileSquareCanInventory";
import type { KegMeasurement } from "@/lib/production/kegDrift";
import type { DeadLink } from "@/lib/square/linkHealth";

interface DriftResponse {
  cans: FamilyMeasurement[];
  kegs: KegMeasurement[];
  deadLinks: DeadLink[];
  unmeasured: { recipeId: string; reason: string; variationName?: string | null }[];
  warnings: string[];
  recipeNames: Record<string, string>;
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/** Drift is signed Square − cold storage, so the sign says which side is ahead. */
function DriftCell({ drift }: { drift: number }) {
  if (drift === 0) {
    return <span className="text-faint tabular-nums">—</span>;
  }
  // Square ahead of cold storage vs behind it are different problems, so they
  // read differently rather than both being "bad".
  const tone = drift > 0 ? "text-info" : "text-danger";
  return (
    <span className={`${tone} font-semibold tabular-nums`}>
      {drift > 0 ? "+" : ""}{fmt(drift)}
    </span>
  );
}

function SectionHeading({ children, count }: { children: React.ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 mb-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-widest text-secondary">{children}</h3>
      {count !== undefined && <span className="text-[11px] text-faint tabular-nums">{count}</span>}
    </div>
  );
}

export default function SquareDriftPanel() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["taproom", "inventory", "drift"],
    queryFn: () => fetchJson<DriftResponse>("/api/taproom/inventory/drift"),
  });

  const summary = useMemo(() => {
    if (!data) return null;
    const all = [
      ...data.cans.map((c) => c.drift),
      ...data.kegs.map((k) => k.drift),
    ];
    return {
      compared: all.length,
      agreeing: all.filter((d) => d === 0).length,
      drifting: all.filter((d) => d !== 0).length,
    };
  }, [data]);

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Reading Square…</div>;
  if (error) return <div className="text-sm text-danger py-8 text-center">{(error as Error).message}</div>;
  if (!data || !summary) return null;

  const name = (id: string) => data.recipeNames[id] || id;
  const driftingKegs = data.kegs.filter((k) => k.drift !== 0);
  const driftingCans = data.cans.filter((c) => c.drift !== 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between rounded-lg border border-accent-border/30 bg-accent-muted/20 px-3 py-2">
        <span className="text-sm text-body">
          Square measured against cold storage. Cold storage is the app&apos;s record; neither side is
          being corrected to the other.
        </span>
        <span className="text-sm tabular-nums whitespace-nowrap">
          <span className="text-strong font-semibold">{summary.agreeing}</span>
          <span className="text-muted"> agree · </span>
          <span className={summary.drifting > 0 ? "text-danger font-semibold" : "text-strong font-semibold"}>
            {summary.drifting}
          </span>
          <span className="text-muted"> drifting</span>
        </span>
      </div>

      {data.deadLinks.length > 0 && (
        <Banner tone="danger">
          <div className="font-semibold mb-1">
            {data.deadLinks.length} mapping{data.deadLinks.length === 1 ? "" : "s"} point at a Square
            variation that isn&apos;t live.
          </div>
          <div className="text-xs mb-1.5">
            These are not zero stock — they are unmeasurable. Nothing can be read from or written to
            them until they&apos;re re-pointed.
          </div>
          <ul className="text-xs flex flex-col gap-0.5">
            {data.deadLinks.map((d) => (
              <li key={d.linkId} className="tabular-nums">
                {name(d.recipeId)} · {d.itemName ?? "?"} · {d.variationName ?? "?"}{" "}
                <span className="text-muted">
                  ({d.reason === "deleted_in_square" ? "deleted in Square" : "not in the catalog mirror — run a sync"})
                </span>
              </li>
            ))}
          </ul>
        </Banner>
      )}

      {data.warnings.length > 0 && (
        <Banner tone="info">
          <ul className="text-xs flex flex-col gap-0.5">
            {data.warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </Banner>
      )}

      {data.unmeasured.length > 0 && (
        <Banner tone="info">
          <div className="font-semibold mb-1">{data.unmeasured.length} could not be compared this run.</div>
          <ul className="text-xs flex flex-col gap-0.5">
            {data.unmeasured.map((u, i) => (
              <li key={i}>{name(u.recipeId)}{u.variationName ? ` · ${u.variationName}` : ""} — {u.reason}</li>
            ))}
          </ul>
        </Banner>
      )}

      {/* ── Kegs ─────────────────────────────────────────────────────────── */}
      <div>
        <SectionHeading count={data.kegs.length}>Kegs</SectionHeading>
        {data.kegs.length === 0 ? (
          <p className="text-xs text-faint">No keg mappings could be compared.</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-line">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line bg-surface">
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Recipe</th>
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Size</th>
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Cold storage breakdown</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Kegs</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Square</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Drift</th>
                </tr>
              </thead>
              <tbody>
                {/* Drifting rows first — the reason anyone opens this view. */}
                {[...driftingKegs, ...data.kegs.filter((k) => k.drift === 0)].map((k) => (
                  <tr key={k.squareVariationId} className="border-b border-line/40">
                    <td className="px-3 py-1.5 text-strong">
                      {name(k.recipeId)}
                      {k.multiRecipe && (
                        <span className="ml-1 text-[10px] text-danger">
                          + {k.multiRecipe.length - 1} other recipe{k.multiRecipe.length > 2 ? "s" : ""}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-body">{k.variationName ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted tabular-nums">
                      {/* Only meaningful when several cold-storage variations feed
                          one Square SKU — otherwise the total says it all. */}
                      {k.components.length > 1
                        ? k.components.map((c) => `${c.label ?? "?"} ${fmt(c.onHand)}`).join("  +  ")
                        : "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-body tabular-nums">{fmt(k.coldStorageKegs)}</td>
                    <td className="px-3 py-1.5 text-right text-body tabular-nums">{fmt(k.squareKegs)}</td>
                    <td className="px-3 py-1.5 text-right"><DriftCell drift={k.drift} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Cans ─────────────────────────────────────────────────────────── */}
      <div>
        <SectionHeading count={data.cans.length}>Cans</SectionHeading>
        <p className="text-[11px] text-muted mb-1.5">
          Square holds one loose-can count per family and derives packs from it, so cold storage&apos;s
          tiers are shown as the slices that sum to the figure being compared.
        </p>
        {data.cans.length === 0 ? (
          <p className="text-xs text-faint">No can families could be compared.</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-line">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="border-b border-line bg-surface">
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Recipe</th>
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Family</th>
                  <th className="px-3 py-2 text-left font-semibold text-secondary">Cold storage breakdown</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Cans</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Square</th>
                  <th className="px-3 py-2 text-right font-semibold text-secondary">Drift</th>
                </tr>
              </thead>
              <tbody>
                {[...driftingCans, ...data.cans.filter((c) => c.drift === 0)].map((c) => (
                  <tr key={c.baseSquareVariationId} className="border-b border-line/40">
                    <td className="px-3 py-1.5 text-strong">{name(c.recipeId)}</td>
                    <td className="px-3 py-1.5 text-body">{c.baseVariationName ?? "—"}</td>
                    <td className="px-3 py-1.5 text-muted tabular-nums">
                      {c.components
                        .filter((p) => p.onHand > 0)
                        .map((p) => `${fmt(p.onHand)} × ${fmt(p.cansEach)}`)
                        .join("  +  ") || "—"}
                    </td>
                    <td className="px-3 py-1.5 text-right text-body tabular-nums">{fmt(c.coldStorageCans)}</td>
                    <td className="px-3 py-1.5 text-right text-body tabular-nums">{fmt(c.squareCans)}</td>
                    <td className="px-3 py-1.5 text-right"><DriftCell drift={c.drift} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
