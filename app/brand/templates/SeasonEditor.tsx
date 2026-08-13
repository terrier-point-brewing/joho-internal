"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";
import { seasonGaps, type BrandSeason } from "@/lib/brand/seasons";
import { useAssets } from "../assets/useAssets";
import { useUpdateSeason } from "./useTemplates";

/**
 * Everything a season carries, split by who reads it.
 *
 * The two groups are not cosmetic. The render inputs are what a `motif` slot
 * resolves against — a renderer reads them and nothing else. The editorial
 * fields are read by people: `cultural_lean` is quoted verbatim into the
 * artist commission brief in the Releases label workflow. Mixing them into one
 * flat form hides which fields can break a render.
 *
 * `motif_set` is deliberately absent: nothing reads it yet, and an asset-list
 * editor for a field with no consumer is a UI that can only go stale.
 */

/** Slot resolution needs a real 6-digit hex; the picker cannot express anything else. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export default function SeasonEditor({ season }: { season: BrandSeason }) {
  const updateSeason = useUpdateSeason();
  const chopAssets = useAssets("chop_glyph");
  const logoAssets = useAssets("logo");

  const [draft, setDraft] = useState({
    background_hex: season.background_hex,
    chop_glyph_asset_id: season.chop_glyph_asset_id,
    season_logo_asset_id: season.season_logo_asset_id,
    cultural_lean: season.cultural_lean ?? "",
    starts_at: season.starts_at?.slice(0, 10) ?? "",
    ends_at: season.ends_at?.slice(0, 10) ?? "",
  });

  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  const gaps = seasonGaps(draft);
  // A window that ends before it starts would sort the season into the wrong
  // place and read as a typo nobody catches until the rotation is wrong.
  const badWindow = Boolean(draft.starts_at && draft.ends_at && draft.ends_at < draft.starts_at);

  return (
    <div className="flex flex-col gap-4 mt-3 pt-3 border-t border-line">
      {/* Render inputs — what a motif slot resolves against. */}
      <div className="flex flex-col gap-3">
        <p className="text-2xs text-faint uppercase tracking-wide">Motif resolution</p>

        <label className="flex items-center gap-2">
          <span className="text-xs text-muted w-28 shrink-0">Background</span>
          <input
            type="color"
            aria-label="Season background color"
            value={draft.background_hex && HEX.test(draft.background_hex) ? draft.background_hex : "#26355d"}
            onChange={(e) => set({ background_hex: e.target.value })}
            className="h-8 w-8 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
          />
          <span className="text-2xs text-muted">{draft.background_hex ?? "not set"}</span>
          {draft.background_hex && (
            <button
              type="button"
              className="btn-secondary btn-xxs"
              onClick={() => set({ background_hex: null })}
            >
              Clear
            </button>
          )}
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">
            Chop glyph <span className="text-danger">·</span> required to activate
          </span>
          <GlyphPicker
            assets={chopAssets.data ?? []}
            emptyHint="No approved chop-glyph assets yet — upload one in Assets under “chop_glyph” and approve it."
            selectedId={draft.chop_glyph_asset_id}
            onSelect={(id) => set({ chop_glyph_asset_id: id })}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-muted">Season logo</span>
          <GlyphPicker
            assets={logoAssets.data ?? []}
            emptyHint="No approved logo assets yet."
            selectedId={draft.season_logo_asset_id}
            onSelect={(id) => set({ season_logo_asset_id: id })}
          />
        </div>
      </div>

      {/* Editorial — read by people, not by the renderer. */}
      <div className="flex flex-col gap-3">
        <p className="text-2xs text-faint uppercase tracking-wide">Editorial</p>

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Cultural lean</span>
          <textarea
            className="inp-sm min-h-16"
            value={draft.cultural_lean}
            placeholder="The direction this season pulls — quoted into every artist brief."
            onChange={(e) => set({ cultural_lean: e.target.value })}
          />
        </label>

        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Starts</span>
            <input
              type="date"
              className="inp-sm"
              value={draft.starts_at}
              onChange={(e) => set({ starts_at: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Ends</span>
            <input
              type="date"
              className="inp-sm"
              value={draft.ends_at}
              onChange={(e) => set({ ends_at: e.target.value })}
            />
          </label>
        </div>
      </div>

      {badWindow && <Banner tone="danger">The end date is before the start date.</Banner>}
      {updateSeason.error && (
        <Banner tone="danger">{(updateSeason.error as Error).message}</Banner>
      )}

      {/* The same gap list the activate gate uses, so the editor and the button
          can never disagree about what is missing. */}
      {gaps.blocking.length > 0 && (
        <Banner tone="danger">
          {season.status === "active"
            ? // A season already in force can still be missing one — the gate is
              // new and predates the rows it now judges. Saying "cannot be
              // activated" about the live season would just read as wrong.
              `This season is active but is missing ${gaps.blocking.join(" and ")} — every motif chop slot will fail validation until it has one.`
            : `This season cannot be activated until it has ${gaps.blocking.join(" and ")}.`}
        </Banner>
      )}
      {gaps.blocking.length === 0 && gaps.warnings.length > 0 && (
        <Banner tone="info">
          No {gaps.warnings.join(" or ")} set — templates with a background motif slot will fail
          validation against this season.
        </Banner>
      )}

      <button
        type="button"
        className="btn-primary self-start"
        disabled={updateSeason.isPending || badWindow}
        onClick={() =>
          updateSeason.mutate({
            id: season.id,
            background_hex: draft.background_hex,
            chop_glyph_asset_id: draft.chop_glyph_asset_id,
            season_logo_asset_id: draft.season_logo_asset_id,
            // Empty is absent, not an empty string — the readers of these
            // fields all test for null.
            cultural_lean: draft.cultural_lean.trim() || null,
            starts_at: draft.starts_at || null,
            ends_at: draft.ends_at || null,
          })
        }
      >
        {updateSeason.isPending ? "Saving…" : "Save season"}
      </button>
    </div>
  );
}

/**
 * Approved assets only — an unapproved asset is one nobody has signed off on,
 * and a season is the last place to smuggle one into a render. Mirrors
 * ChopPicker in the Releases label workflow.
 */
function GlyphPicker({
  assets,
  selectedId,
  onSelect,
  emptyHint,
}: {
  assets: BrandAsset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  emptyHint: string;
}) {
  const approved = assets.filter((a) => a.status === "approved");
  if (approved.length === 0) return <p className="text-2xs text-faint">{emptyHint}</p>;
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-14 h-14 rounded border grid place-items-center text-2xs ${selectedId === null ? "border-accent" : "border-line"}`}
      >
        None
      </button>
      {approved.map((a) => (
        <button
          key={a.id}
          type="button"
          title={a.title ?? a.variant}
          onClick={() => onSelect(a.id)}
          className={`w-14 h-14 rounded border overflow-hidden ${selectedId === a.id ? "border-accent ring-1 ring-accent" : "border-line"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={assetFileUrl(a.id)}
            alt={a.alt_text ?? a.variant}
            className="w-full h-full object-contain"
          />
        </button>
      ))}
    </div>
  );
}
