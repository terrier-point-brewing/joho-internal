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
import { buildVariationLinkMatrix } from "@/lib/production/recipeLinkMatrix";
import type { VariationLinkGroup, VariationLinkRow } from "@/lib/production/recipeLinkMatrix";
import { SquareCatalogSelect } from "@/app/components/SquareCatalogSelect";

interface SquareSelection {
  squareVariationId: string;
  squareItemId: string;
  variationName: string;
  itemName: string;
}

function RowView({
  row,
  onLink,
  onDelete,
}: {
  row: VariationLinkRow;
  onLink: (p: SquareSelection) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const { data: catalog } = useExportSquareCatalogQuery();
  const items = catalog?.items ?? [];

  if (row.state === "linked") {
    return (
      <div className="flex items-center gap-1 group">
        <span className="text-emerald-400 text-[11px] leading-tight">
          ✓ {row.linkedItemName ?? row.linkedVariationName ?? "linked"}
          {row.linkedVariationName ? ` · ${row.linkedVariationName}` : ""}
        </span>
        <button
          className="text-zinc-700 hover:text-red-400 text-[10px] opacity-0 group-hover:opacity-100 transition-opacity ml-1"
          disabled={saving}
          title="Remove link"
          onClick={async () => {
            if (!row.linkId) return;
            setSaving(true);
            await onDelete(row.linkId);
            setSaving(false);
          }}
        >
          ×
        </button>
      </div>
    );
  }

  if (row.state === "suggested" && !editing) {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-amber-400 text-[11px] leading-tight">
          ~ {row.suggestion?.variationName ?? row.suggestion?.itemName ?? "suggested"}
        </span>
        <div className="flex gap-1">
          <button
            className="text-[10px] text-amber-500 hover:text-amber-300 underline"
            disabled={saving}
            onClick={async () => {
              if (!row.suggestion) return;
              setSaving(true);
              await onLink({
                squareVariationId: row.suggestion.variationId,
                squareItemId: row.suggestion.itemId,
                variationName: row.suggestion.variationName,
                itemName: row.suggestion.itemName,
              });
              setSaving(false);
            }}
          >
            Accept
          </button>
          <button className="text-[10px] text-zinc-600 hover:text-zinc-400" onClick={() => setEditing(true)}>
            Change
          </button>
        </div>
      </div>
    );
  }

  if (row.state === "empty" && !editing) {
    return (
      <button className="text-zinc-700 hover:text-zinc-400 text-xs transition-colors" onClick={() => setEditing(true)}>
        + link
      </button>
    );
  }

  return (
    <div className="min-w-[220px]">
      <SquareCatalogSelect
        items={items}
        itemId={null}
        variationId={null}
        onChange={async (itemId, variationId) => {
          if (!variationId || !itemId) { setEditing(false); return; }
          const catalogItem = items.find((i) => i.itemId === itemId);
          const catalogVariation = catalogItem?.variations.find((v) => v.variationId === variationId);
          setSaving(true);
          await onLink({
            squareVariationId: variationId,
            squareItemId: itemId,
            variationName: catalogVariation?.variationName ?? "",
            itemName: catalogItem?.itemName ?? "",
          });
          setSaving(false);
          setEditing(false);
        }}
      />
      <button className="text-[10px] text-zinc-600 hover:text-zinc-400 mt-0.5" onClick={() => setEditing(false)}>
        Cancel
      </button>
    </div>
  );
}

function GroupTable({
  group,
  onLink,
  onDelete,
  onAcceptAll,
}: {
  group: VariationLinkGroup;
  onLink: (row: VariationLinkRow, p: SquareSelection) => Promise<void>;
  onDelete: (linkId: string) => Promise<void>;
  onAcceptAll: (group: VariationLinkGroup) => Promise<void>;
}) {
  const [accepting, setAccepting] = useState(false);
  const unmapped = group.rows.filter((r) => r.state !== "linked").length;
  const hasSuggestions = group.rows.some((r) => r.state === "suggested");

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wide">
          {group.partnerName}
          <span className="ml-2 text-zinc-600 normal-case font-normal">
            {unmapped > 0 ? `${unmapped} unmapped` : "all mapped"}
          </span>
        </h4>
        {hasSuggestions && (
          <button
            disabled={accepting}
            onClick={async () => { setAccepting(true); await onAcceptAll(group); setAccepting(false); }}
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
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap w-40">Beer</th>
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">Packaging variation</th>
              <th className="px-3 py-2 text-left text-zinc-500 font-medium whitespace-nowrap">Square link</th>
            </tr>
          </thead>
          <tbody>
            {group.rows.map((row) => (
              <tr key={row.recipePackagingVariationId} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-900/20">
                <td className="px-3 py-2.5 text-zinc-200 font-medium whitespace-nowrap">{row.beerName}</td>
                <td className="px-3 py-2.5 text-zinc-400 whitespace-nowrap">{row.variationLabel}</td>
                <td className="px-3 py-2.5 align-top">
                  <RowView row={row} onLink={(p) => onLink(row, p)} onDelete={onDelete} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function RecipeLinkMatrix() {
  const qc = useQueryClient();
  const { data: rpvs = [] } = useRecipePackagingVariationsExpandedQuery();
  const { data: recipes = [] } = useRecipesQuery();
  const { data: links = [] } = useRecipeSquareLinksQuery();
  const { data: catalog } = useExportSquareCatalogQuery();

  const groups: VariationLinkGroup[] = catalog
    ? buildVariationLinkMatrix(rpvs, recipes, links, catalog)
    : [];

  async function refreshLinks() {
    await qc.invalidateQueries({ queryKey: queryKeys.production.recipeSquareLinks() });
  }

  async function saveLink(row: VariationLinkRow, p: SquareSelection) {
    const packaging = row.containerType;
    const res = await fetch("/api/production/recipe-square-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipe_id: row.recipeId,
        packaging,
        variation_id: row.variationId,
        square_variation_id: p.squareVariationId,
        square_item_id: p.squareItemId,
        variation_name: p.variationName,
        item_name: p.itemName,
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

  async function handleAcceptAll(group: VariationLinkGroup) {
    const toSave = group.rows.filter((r) => r.state === "suggested" && r.suggestion);
    await Promise.all(
      toSave.map((r) =>
        saveLink(r, {
          squareVariationId: r.suggestion!.variationId,
          squareItemId: r.suggestion!.itemId,
          variationName: r.suggestion!.variationName,
          itemName: r.suggestion!.itemName,
        })
      )
    );
  }

  if (groups.length === 0) {
    return <p className="text-xs text-zinc-600 italic">No active keg/can packaging variations found.</p>;
  }

  return (
    <div>
      <p className="text-xs text-zinc-600 mb-4">
        Map each beer&apos;s packaging variation to a Square catalog variation. Green = linked, amber =
        auto-suggested (review before accepting), + link = unmapped. One row per packaging variation, so
        differently-branded variations of the same container map independently.
      </p>
      {groups.map((group) => (
        <GroupTable
          key={group.partnerId ?? "__house__"}
          group={group}
          onLink={saveLink}
          onDelete={handleDelete}
          onAcceptAll={handleAcceptAll}
        />
      ))}
    </div>
  );
}
