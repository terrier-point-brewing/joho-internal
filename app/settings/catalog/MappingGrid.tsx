"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useSquareMappingGridQuery } from "@/app/production/hooks/queries";
import { usePermissions } from "@/lib/hooks/useUserRole";
import { CAP } from "@/lib/auth/capabilities";
import { queryKeys } from "@/lib/query-keys";
import type { MappingCellVariation, MappingGridRow, MappingColumn } from "@/app/production/types";

function syncedAgo(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms) || ms < 0) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

async function acceptSuggestion(
  recipeId: string,
  packaging: "draft" | "keg" | "can",
  variationId: string | null,
  suggestion: NonNullable<MappingCellVariation["suggestion"]>
) {
  const body: Record<string, unknown> = {
    recipe_id: recipeId,
    packaging,
    square_variation_id: suggestion.squareVariationId,
    square_item_id: suggestion.squareItemId ?? null,
    variation_name: suggestion.squareName.split(" · ")[1] ?? null,
    item_name: suggestion.squareName.split(" · ")[0] ?? null,
  };
  if (variationId && variationId !== "draft") body.variation_id = variationId;
  const res = await fetch("/api/production/recipe-square-links", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error((json as { error?: string }).error ?? "Accept failed");
  }
}

function colPackaging(col: MappingColumn): "draft" | "keg" | "can" {
  return col.type === "draft" ? "draft" : col.type === "keg" ? "keg" : "can";
}

// Short label for a variation within a column — strips the column context from the name.
// "Fortnight Blank Coast IPA - 1/2 Keg" in "1/2 Keg" column → "Fortnight Blank Coast IPA"
// "1/2 Keg" in "1/2 Keg" column → "Standard"
function varLabel(variationName: string, colLabel: string): string {
  if (variationName === colLabel) return "Standard";
  if (variationName === `Standard ${colLabel}`) return "Standard";
  const suffix = ` - ${colLabel}`;
  if (variationName.endsWith(suffix)) return variationName.slice(0, -suffix.length);
  return variationName;
}

function colMinWidth(_col: MappingColumn): string {
  return "min-w-[180px]";
}

export default function MappingGrid({
  onCellClick,
}: {
  onCellClick: (recipeId: string, colKey: string) => void;
}) {
  const { data, isLoading, error } = useSquareMappingGridQuery();
  const qc = useQueryClient();
  // "Refresh from Square" posts to /api/finance/sync-catalog, which is gated
  // finance.transactions:manage — a different domain from the `catalog` scope
  // that opens this screen. Holding one does not imply the other, so the
  // button is hidden rather than left to 403 on click.
  const { can } = usePermissions();
  const canSyncCatalog = can(CAP.financeTransactionsManage);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  async function refreshFromSquare() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch("/api/finance/sync-catalog", { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Sync failed");
      }
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] }),
        qc.invalidateQueries({ queryKey: queryKeys.production.squareCatalog() }),
      ]);
    } catch (err) {
      setSyncError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  if (isLoading) return <div className="text-sm text-muted py-8 text-center">Loading grid…</div>;
  if (error) return <div className="text-sm text-danger py-8 text-center">{(error as Error).message}</div>;
  if (!data) return null;

  const { columns, rows } = data;

  function countHighConfidence(colKey: string): MappingCellVariation[] {
    const result: MappingCellVariation[] = [];
    for (const row of rows) {
      const cell = row.cells[colKey];
      if (!cell) continue;
      for (const v of cell.variations) {
        if (!v.linkId && !v.ignored && v.suggestion?.confidence === "high") result.push(v);
      }
    }
    return result;
  }

  const highByCol = new Map(columns.map((c) => [c.key, countHighConfidence(c.key)]));
  const totalHigh = [...highByCol.values()].reduce((s, vs) => s + vs.length, 0);

  async function fillColumn(col: MappingColumn) {
    await Promise.all(
      rows.flatMap((row) => {
        const cell = row.cells[col.key];
        if (!cell) return [];
        return cell.variations
          .filter((v) => !v.linkId && !v.ignored && v.suggestion?.confidence === "high")
          .map((v) =>
            acceptSuggestion(
              row.recipeId,
              colPackaging(col),
              v.variationId === "draft" ? null : v.variationId,
              v.suggestion!
            )
          );
      })
    );
    qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
  }

  async function fillAll() {
    await Promise.all(columns.map((col) => fillColumn(col)));
  }

  async function acceptOne(
    row: MappingGridRow,
    col: MappingColumn,
    v: MappingCellVariation,
    e: React.MouseEvent
  ) {
    e.stopPropagation();
    if (!v.suggestion) return;
    await acceptSuggestion(
      row.recipeId,
      colPackaging(col),
      v.variationId === "draft" ? null : v.variationId,
      v.suggestion
    );
    qc.invalidateQueries({ queryKey: ["production", "square-mapping-grid"] });
  }

  const syncedLabel = syncedAgo(data.catalogSyncedAt);

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {canSyncCatalog && (
            <button onClick={refreshFromSquare} disabled={syncing} className="btn-secondary">
              {syncing ? "Syncing…" : "Refresh from Square"}
            </button>
          )}
          {syncedLabel && (
            <span className="text-xs text-muted">Catalog synced {syncedLabel}</span>
          )}
        </div>
        {syncError && <span className="text-xs text-danger">{syncError}</span>}
      </div>

      {totalHigh > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-info-border/40 bg-info-surface/20 px-4 py-2.5">
          <span className="text-sm text-info">
            {totalHigh} high-confidence suggestion{totalHigh !== 1 ? "s" : ""} ready to accept
          </span>
          <button
            onClick={fillAll}
            className="btn-primary"
          >
            Fill all suggested
          </button>
        </div>
      )}

      <div className="overflow-x-auto overflow-y-auto max-h-[calc(100vh-140px)] rounded-lg border border-line">
        <table className="text-xs border-collapse" style={{ tableLayout: "fixed", width: "max-content", minWidth: "100%" }}>
          <colgroup>
            <col style={{ width: 200 }} />
            {columns.map((col) => (
              <col key={col.key} style={{ width: 180 }} />
            ))}
          </colgroup>
          <thead>
            <tr className="border-b border-line">
              <th className="sticky left-0 top-0 z-30 bg-surface px-4 py-2.5 text-left font-semibold text-secondary whitespace-nowrap">
                Recipe
              </th>
              {columns.map((col) => {
                const n = (highByCol.get(col.key) ?? []).length;
                return (
                  <th
                    key={col.key}
                    className={`sticky top-0 z-20 bg-surface px-3 py-2.5 text-left font-medium text-secondary whitespace-nowrap ${colMinWidth(col)}`}
                  >
                    <div className="flex flex-col gap-1">
                      <span>{col.label}</span>
                      {n > 0 && (
                        <button
                          onClick={() => fillColumn(col)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-info-surface/40 border border-info-border/50 text-info hover:bg-info-surface/40 transition-colors w-fit"
                        >
                          Fill {n}
                        </button>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.flatMap((row, i) => {
              const showHeader = i === 0 || row.recipePartnerName !== rows[i - 1].recipePartnerName;
              const header = showHeader ? (
                <tr key={`group-${row.recipePartnerName ?? "house"}`}>
                  <td
                    colSpan={columns.length + 1}
                    className="px-4 py-1 text-[10px] font-semibold uppercase tracking-widest text-faint bg-surface/40 border-b border-line/40"
                  >
                    {row.recipePartnerName ?? "House"}
                  </td>
                </tr>
              ) : null;

              return [
                header,
                <tr key={row.recipeId} className="border-b border-line/40 hover:bg-surface/20 transition-colors">
                  <td className="sticky left-0 z-10 bg-canvas px-4 py-2.5 font-medium text-strong whitespace-nowrap border-r border-line/40 overflow-hidden text-ellipsis">
                    {row.recipeName}
                  </td>
                  {columns.map((col) => {
                    const cell = row.cells[col.key];

                    // Recipe has no packaging variation for this column — structural empty
                    if (cell === null) {
                      return (
                        <td key={col.key} className="px-3 py-2.5 text-center text-disabled">
                          —
                        </td>
                      );
                    }

                    const multi = cell.variations.length > 1;

                    return (
                      <td
                        key={col.key}
                        className="px-3 py-2.5 cursor-pointer align-middle"
                        onClick={() => onCellClick(row.recipeId, col.key)}
                      >
                        <div className="flex flex-col gap-1">
                          {cell.variations.map((v) => {
                            const isLinked = !!v.linkId;
                            const isHighConf = !isLinked && v.suggestion?.confidence === "high";
                            const isMedConf = !isLinked && v.suggestion?.confidence === "medium";
                            const label = multi ? varLabel(v.variationName, col.label) : null;

                            if (isLinked) {
                              const squareName = v.linkedSquareName || v.variationName;
                              return (
                                <span
                                  key={v.variationId}
                                  className="inline-block px-1.5 py-0.5 rounded text-[10px] bg-success-surface/30 border border-success-border/50 text-success break-words leading-4"
                                  title={squareName}
                                >
                                  {label && (
                                    <span className="text-success mr-0.5">{label}:</span>
                                  )}
                                  ✓ {squareName}
                                </span>
                              );
                            }

                            if (isHighConf || isMedConf) {
                              const squareName = v.suggestion!.squareName;
                              const chipColor = isHighConf
                                ? "border-info-border/50 text-info"
                                : "border-accent-border/40 text-accent";
                              const labelColor = isHighConf ? "text-info" : "text-accent-emphasis";
                              const sparkColor = isHighConf ? "text-info" : "text-accent-emphasis";
                              return (
                                <span
                                  key={v.variationId}
                                  className={`inline-flex items-start gap-1.5 px-1.5 py-0.5 rounded text-[10px] border break-words leading-4 ${chipColor}`}
                                  title={squareName}
                                >
                                  <span className="flex-1 min-w-0">
                                    {label && (
                                      <span className={`block text-[9px] mb-0.5 ${labelColor}`}>{label}</span>
                                    )}
                                    <span>
                                      <span className={`opacity-50 mr-0.5 text-[8px] ${sparkColor}`}>✦</span>
                                      {squareName}
                                    </span>
                                  </span>
                                  <button
                                    data-accept-chip
                                    type="button"
                                    className="shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-sm bg-success-surface/50 border border-success-border/60 text-success hover:bg-success-surface/70 transition-colors self-start mt-0.5 text-[9px] leading-none"
                                    onClick={(e) => acceptOne(row, col, v, e)}
                                    title="Accept this suggestion"
                                  >
                                    ✓
                                  </button>
                                </span>
                              );
                            }

                            if (v.ignored) {
                              return (
                                <span
                                  key={v.variationId}
                                  className="inline-block px-1.5 py-0.5 rounded text-[10px] border border-line text-muted bg-surface-mid/40 break-words leading-4"
                                  title="Ignored — no Square mapping needed"
                                >
                                  {label ? `${label}: ` : ""}Ignored
                                </span>
                              );
                            }

                            // Unmapped, no suggestion — red chip to flag missing mapping
                            return (
                              <span
                                key={v.variationId}
                                className="inline-block px-1.5 py-0.5 rounded text-[10px] border border-danger-border/40 text-danger bg-danger-surface/10 break-words leading-4"
                              >
                                {label ? `${label}: —` : "—"}
                              </span>
                            );
                          })}
                        </div>
                      </td>
                    );
                  })}
                </tr>,
              ];
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
