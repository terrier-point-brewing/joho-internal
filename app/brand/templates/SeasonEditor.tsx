"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";
import {
  motifResolutionGaps,
  SEASON_PALETTE_ROLES,
  type BrandSeason,
  type CanonToken,
  type SeasonPalette,
  type SeasonPaletteRole,
} from "@/lib/brand/seasons";
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
 * `motif_set` is deliberately absent and now legacy: a season's motifs are rows
 * in `brand_season_assets`, edited by SeasonKitEditor underneath this.
 */

/** Slot resolution needs a real 6-digit hex; the picker cannot express anything else. */
const HEX = /^#[0-9a-fA-F]{6}$/;

export default function SeasonEditor({
  season,
  tokens,
}: {
  season: BrandSeason;
  tokens: CanonToken[];
}) {
  const updateSeason = useUpdateSeason();
  const chopAssets = useAssets("chop_glyph");
  const logoAssets = useAssets("logo");

  const [draft, setDraft] = useState({
    background_hex: season.background_hex,
    chop_glyph_asset_id: season.chop_glyph_asset_id,
    season_logo_asset_id: season.season_logo_asset_id,
    palette: (season.palette ?? {}) as SeasonPalette,
    cultural_lean: season.cultural_lean ?? "",
    voice_note: season.voice_note ?? "",
    starts_at: season.starts_at?.slice(0, 10) ?? "",
    ends_at: season.ends_at?.slice(0, 10) ?? "",
  });

  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));

  // What a motif SLOT cannot resolve — a different question from whether the
  // kit is finished, which is `kitGaps` and is the board's and the gate's.
  const render = motifResolutionGaps(draft);
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

      {/* Palette — roles that SELECT from the canon. A season never redefines. */}
      <div className="flex flex-col gap-3">
        <p className="text-2xs text-faint uppercase tracking-wide">Palette roles</p>

        {SEASON_PALETTE_ROLES.map((role) => (
          <PaletteRolePicker
            key={role}
            role={role}
            tokens={tokens}
            value={draft.palette[role] ?? null}
            onSelect={(key) =>
              set({
                palette: { ...draft.palette, [role]: key ?? undefined },
              })
            }
          />
        ))}

        <p className="text-2xs text-faint">
          Roles point at a color the canon declares, never a hex — so a canon change
          propagates, and a season cannot quietly invent a fourth brand color. The ground
          above is the exception: it is the season&rsquo;s own. If the color you want is not
          in this list, the canon is what should change.
        </p>
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

        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Voice note</span>
          <textarea
            className="inp-sm min-h-16"
            value={draft.voice_note}
            placeholder="How this season sounds — one or two sentences."
            onChange={(e) => set({ voice_note: e.target.value })}
          />
          <span className="text-2xs text-faint">
            An inflection of the canon&rsquo;s voice, not a replacement. If it reads like a
            different brand talking, it is wrong.
          </span>
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

      {/* What a RENDER cannot resolve, which is not the same as what the kit is
          short of. The board says the second, in one sentence, from `kitGaps`;
          this says the first, and deliberately never claims an activation
          verdict of its own — one completeness rule, one place. It is worth
          saying about the season already in force above all: "Season 1" is
          active with no glyph, and only this line says what that costs. */}
      {render.unresolvable.length > 0 && (
        <Banner tone="danger">
          {season.status === "active"
            ? `This season is in force but has no ${render.unresolvable.join(" or ")} — every motif chop slot fails validation against it until it does.`
            : `Without ${render.unresolvable.join(" or ")}, every motif chop slot will fail validation against this season.`}
        </Banner>
      )}
      {render.unresolvable.length === 0 && render.degraded.length > 0 && (
        <Banner tone="info">
          No {render.degraded.join(" or ")} set — templates with a background motif slot will fail
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
            // Validated against the LIVE canon server-side: the picker can only
            // express a canon key, and the route refuses anything else.
            palette: draft.palette,
            // Empty is absent, not an empty string — the readers of these
            // fields all test for null.
            cultural_lean: draft.cultural_lean.trim() || null,
            voice_note: draft.voice_note.trim() || null,
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
 * A palette role, chosen from what the canon declares and nothing else.
 *
 * Deliberately a list rather than a colour input. The season stores a token KEY,
 * so a canon change propagates; a hex field here would let a season invent a
 * brand colour, which is the one thing a season may never do. The season ground
 * keeps its colour input above, because that value genuinely is the season's own.
 *
 * A key the canon no longer declares is named rather than silently swallowed —
 * the select falls back to "none", so saving clears it, which is a deliberate
 * act by whoever has just read the line underneath.
 */
function PaletteRolePicker({
  role,
  tokens,
  value,
  onSelect,
}: {
  role: SeasonPaletteRole;
  tokens: CanonToken[];
  value: string | null;
  onSelect: (key: string | null) => void;
}) {
  const token = tokens.find((t) => t.key === value);
  const stale = Boolean(value && !token);

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-2">
        <span className="text-xs text-muted w-28 shrink-0 capitalize">{role}</span>
        <span
          className={`h-8 w-8 shrink-0 rounded border ${
            token ? "border-line-strong" : "border-dashed border-line-strong bg-surface-mid"
          }`}
          // The canon's colour, shown as itself — the same exception the board
          // swatches take.
          style={token ? { backgroundColor: token.hex } : undefined}
        />
        <select
          className="inp-sm w-56"
          value={token ? token.key : ""}
          aria-label={`${role} color`}
          onChange={(e) => onSelect(e.target.value || null)}
        >
          <option value="">— none —</option>
          {tokens.map((t) => (
            <option key={t.key} value={t.key}>
              {t.name} · {t.key}
            </option>
          ))}
        </select>
      </label>
      {stale && (
        <span className="text-2xs text-danger">
          “{value}” is no longer a color the canon declares. Pick one, or save to clear it.
        </span>
      )}
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
