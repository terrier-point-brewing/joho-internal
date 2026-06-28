"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useSquareMappingGridQuery } from "@/app/production/hooks/queries";
import type { MappingCellVariation, MappingGridRow, MappingColumn } from "@/app/production/types";

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

export default function MappingGrid({
  onCellClick,
}: {
  onCellClick: (recipeId: string, colKey: string) => void;
}) {
  const { data, isLoading, error } = useSquareMappingGridQuery();
  const qc = useQueryClient();

  if (isLoading) return <div className="text-sm text-zinc-500 py-8 text-center">Loading grid…</div>;
  if (error) return <div className="text-sm text-red-400 py-8 text-center">{(error as Error).message}</div>;
  if (!data) return null;

  const { columns, rows } = data;

  // Count high-confidence suggestions per column for "Fill N" buttons
  function countHighConfidence(colKey: string): MappingCellVariation[] {
    const result: MappingCellVariation[] = [];
    for (const row of rows) {
      const cell = row.cells[colKey];
      if (!cell) continue;
      for (const v of cell.variations) {
        if (!v.linkedSquareCatalogVariationId && v.suggestion?.confidence === "high") {
          result.push(v);
        }
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
          .filter((v) => !v.linkedSquareCatalogVariationId && v.suggestion?.confidence === "high")
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

  return (
    <div>
      {totalHigh > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-lg border border-blue-800/40 bg-blue-950/20 px-4 py-2.5">
          <span className="text-sm text-blue-300">
            {totalHigh} high-confidence suggestion{totalHigh !== 1 ? "s" : ""} ready to accept
          </span>
          <button
            onClick={fillAll}
            className="text-xs px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
          >
            Fill all suggested
          </button>
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-xs border-collapse">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/60">
              <th className="sticky left-0 z-10 bg-zinc-900 px-4 py-2.5 text-left font-semibold text-zinc-400 whitespace-nowrap">
                Recipe
              </th>
              {columns.map((col) => {
                const n = (highByCol.get(col.key) ?? []).length;
                return (
                  <th key={col.key} className="px-3 py-2.5 text-left font-medium text-zinc-400 whitespace-nowrap">
                    <div className="flex flex-col gap-1">
                      <span>{col.label}</span>
                      {n > 0 && (
                        <button
                          onClick={() => fillColumn(col)}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900/40 border border-blue-800/50 text-blue-400 hover:bg-blue-800/40 transition-colors w-fit"
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
            {rows.map((row) => (
              <tr key={row.recipeId} className="border-b border-zinc-800/40 hover:bg-zinc-900/20 transition-colors">
                <td className="sticky left-0 z-10 bg-zinc-950 px-4 py-2.5 font-medium text-zinc-200 whitespace-nowrap border-r border-zinc-800/40">
                  {row.recipeName}
                </td>
                {columns.map((col) => {
                  const cell = row.cells[col.key];
                  if (cell === null) {
                    return (
                      <td key={col.key} className="px-3 py-2.5 text-center text-zinc-700">
                        —
                      </td>
                    );
                  }
                  return (
                    <td
                      key={col.key}
                      className="px-3 py-2.5 cursor-pointer"
                      onClick={() => onCellClick(row.recipeId, col.key)}
                    >
                      <div className="flex flex-wrap gap-1">
                        {cell.variations.map((v) => {
                          const isLinked = !!v.linkedSquareCatalogVariationId;
                          const isHighConf = !isLinked && v.suggestion?.confidence === "high";
                          const isMedConf = !isLinked && v.suggestion?.confidence === "medium";

                          if (isLinked) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-emerald-900/30 border border-emerald-700/50 text-emerald-300"
                                title={v.linkedSquareName ?? ""}
                              >
                                ✓ {v.variationName}
                              </span>
                            );
                          }
                          if (isHighConf) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] border border-blue-700/50 text-blue-300"
                                title={`Suggested: ${v.suggestion!.squareName}`}
                              >
                                {v.variationName}
                                <button
                                  data-accept-chip
                                  className="ml-0.5 text-blue-400 hover:text-blue-200 font-bold"
                                  onClick={(e) => acceptOne(row, col, v, e)}
                                >
                                  ✓
                                </button>
                              </span>
                            );
                          }
                          if (isMedConf) {
                            return (
                              <span
                                key={v.variationId}
                                className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-amber-700/40 text-amber-400"
                                title={`Suggested: ${v.suggestion!.squareName}`}
                              >
                                {v.variationName} ?
                              </span>
                            );
                          }
                          return (
                            <span
                              key={v.variationId}
                              className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] border border-zinc-700/40 text-zinc-500"
                            >
                              {v.variationName} —
                            </span>
                          );
                        })}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
