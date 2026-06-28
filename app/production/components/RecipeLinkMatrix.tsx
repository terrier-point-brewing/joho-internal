"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import {
  useRecipePackagingVariationsExpandedQuery,
  useRecipesQuery,
  useRecipeSquareLinksQuery,
  useExportSquareCatalogQuery,
} from "../hooks/queries";
import { buildMatrix, deriveColumns } from "@/lib/production/recipeLinkMatrix";
import type { MatrixColumn, MatrixCell, MatrixGroup } from "@/lib/production/recipeLinkMatrix";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

// ─── Cell component ──────────────────────────────────────────────────────────

function MatrixCellView({
  cell,
  onLink,
  onDelete,
}: {
  cell: MatrixCell;
  col: MatrixColumn;
  onLink: (variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: catalog } = useExportSquareCatalogQuery();
  const items = catalog?.items ?? [];

  if (cell.state === "na") {
    return <span className="text-zinc-800 text-xs select-none">—</span>;
  }

  if (cell.state === "linked") {
    return (
      <div className="flex items-center gap-1 group">
        <span className="text-emerald-400 text-[11px] leading-tight">
          ✓ {cell.variationName ?? cell.itemName ?? "linked"}
        </span>
        <button
          className="text-zinc-700 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
          onClick={async () => {
            if (!cell.linkId) return;
            setSaving(true);
            await onDelete(cell.linkId);
            setSaving(false);
          }}
          disabled={saving}
          title="Remove link"
        >
          ×
        </button>
      </div>
    );
  }

  if (cell.state === "suggested" && !editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-amber-400 text-[11px] leading-tight">
          ~ {cell.suggestion?.variationName ?? cell.suggestion?.itemName ?? "suggested"}
        </span>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-amber-500 hover:text-amber-300 underline"
            disabled={saving}
            onClick={async () => {
              if (!cell.suggestion) return;
              setSaving(true);
              await onLink(
                cell.suggestion.variationId,
                cell.suggestion.itemId,
                cell.suggestion.variationName,
                cell.suggestion.itemName
              );
              setSaving(false);
            }}
          >
            Accept
          </button>
          <button
            className="text-[10px] text-zinc-600 hover:text-zinc-400"
            onClick={() => setEditing(true)}
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  // "empty" state or editing mode (also used when "suggested" + Change was clicked)
  if (cell.state === "empty" || editing) {
    if (!editing) {
      return (
        <button
          className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors"
          onClick={() => setEditing(true)}
        >
          + link
        </button>
      );
    }
    return (
      <div className="min-w-[200px]">
        <SquareCatalogSelect
          items={items}
          itemId={null}
          variationId={null}
          onChange={async (itemId, variationId) => {
            if (!variationId || !itemId) { setEditing(false); return; }
            const catalogItem = items.find((i) => i.itemId === itemId);
            const catalogVariation = catalogItem?.variations.find((v) => v.variationId === variationId);
            setSaving(true);
            await onLink(
              variationId,
              itemId,
              catalogVariation?.variationName ?? "",
              catalogItem?.itemName ?? ""
            );
            setSaving(false);
            setEditing(false);
          }}
        />
        <button
          className="text-[10px] text-zinc-600 hover:text-zinc-400 mt-0.5"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    );
  }

  return null;
}

// ─── Group row table ──────────────────────────────────────────────────────────

function MatrixGroupTable({
  group,
  columns,
  onLink,
  onDelete,
  onAcceptAll,
}: {
  group: MatrixGroup;
  columns: MatrixColumn[];
  onLink: (recipeId: string, cell: MatrixCell, col: MatrixColumn, variationId: string, itemId: string, variationName: string, itemName: string) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
  onAcceptAll: (group: MatrixGroup) => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const hasSuggestions = group.rows.some((r) =>
    [...r.cells.values()].some((c) => c.state === "suggested")
  );

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          {group.partnerName}
        </h4>
        {hasSuggestions && (
          <button
            disabled={accepting}
            onClick={async () => {
              setAccepting(true);
              await onAcceptAll(group);
              setAccepting(false);
            }}
            className="text-xs text-amber-500 hover:text-amber-400 transition-colors disabled:opacity-50"
          >
            {accepting ? "Accepting…" : "Accept all suggestions"}
          </button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-zinc-800">
        <table className="text-xs border-collapse min-w-full">
          <thead>
            <tr className="border-b border-zinc-800 bg-zinc-900/50">
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap w-40">Recipe</th>
              {columns.map((col) => (
                <th key={col.key} className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.recipeId} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/20">
                <td className="px-3 py-2.5 text-zinc-200 font-medium whitespace-nowrap">{row.beerName}</td>
                {columns.map((col) => {
                  const cell = row.cells.get(col.key) ?? {
                    state: "na" as const,
                    packagingItemId: null,
                    packagingFormat: null,
                    linkId: null,
                    variationId: null,
                    variationName: null,
                    itemName: null,
                    suggestion: null,
                  };
                  return (
                    <td key={col.key} className="px-3 py-2.5 align-top">
                      <MatrixCellView
                        cell={cell}
                        col={col}
                        onLink={(vId, iId, vName, iName) =>
                          onLink(row.recipeId, cell, col, vId, iId, vName, iName)
                        }
                        onDelete={onDelete}
                      />
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

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function RecipeLinkMatrix() {
  const qc = useQueryClient();
  const { data: rpvs = [] } = useRecipePackagingVariationsExpandedQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: links = [] } = useRecipeSquareLinksQuery();
  const { data: catalog } = useExportSquareCatalogQuery();

  const columns = deriveColumns(rpvs);
  const groups: MatrixGroup[] = catalog
    ? buildMatrix(recipes, rpvs, links, catalog, columns)
    : [];

  async function refreshLinks() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
  }

  async function handleLinkWithType(
    recipeId: string,
    cell: MatrixCell,
    col: MatrixColumn,
    variationId: string,
    itemId: string,
    variationName: string,
    itemName: string
  ) {
    if (!cell.packagingItemId) return;
    const packaging = col.piType === "keg" ? "keg" : "can";
    const res = await fetch("/api/production/recipe-square-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_id: recipeId,
        packaging,
        packaging_item_id: cell.packagingItemId,
        packaging_format: cell.packagingFormat ?? null,
        square_variation_id: variationId,
        square_item_id: itemId,
        variation_name: variationName,
        item_name: itemName,
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      alert(body.error ?? "Failed to save link");
      return;
    }
    await refreshLinks();
  }

  async function handleDelete(linkId: string) {
    const res = await fetch(`/api/production/recipe-square-links?id=${linkId}`, { method: "DELETE" });
    if (!res.ok) { alert("Failed to remove link"); return; }
    await refreshLinks();
  }

  async function handleAcceptAll(group: MatrixGroup) {
    const toSave: Array<{ recipeId: string; cell: MatrixCell; col: MatrixColumn }> = [];
    for (const row of group.rows) {
      for (const col of columns) {
        const cell = row.cells.get(col.key);
        if (cell?.state === "suggested" && cell.suggestion && cell.packagingItemId) {
          toSave.push({ recipeId: row.recipeId, cell, col });
        }
      }
    }
    await Promise.all(
      toSave.map(({ recipeId, cell, col }) =>
        handleLinkWithType(
          recipeId,
          cell,
          col,
          cell.suggestion!.variationId,
          cell.suggestion!.itemId,
          cell.suggestion!.variationName,
          cell.suggestion!.itemName
        )
      )
    );
  }

  if (columns.length === 0) {
    return (
      <p className="text-xs text-zinc-600 italic">
        No active packaging variations found.
      </p>
    );
  }

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-4">
        Map each recipe + container format to a Square catalog variation. Green = linked, amber = auto-suggested (review before accepting), + link = unlinked.
      </p>
      {groups.map((group) => (
        <MatrixGroupTable
          key={group.partnerId ?? "__house__"}
          group={group}
          columns={columns}
          onLink={(recipeId, cell, col, vId, iId, vName, iName) =>
            handleLinkWithType(recipeId, cell, col, vId, iId, vName, iName)
          }
          onDelete={handleDelete}
          onAcceptAll={handleAcceptAll}
        />
      ))}
    </div>
  );
}
