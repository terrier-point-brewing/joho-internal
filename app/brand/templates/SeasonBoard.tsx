"use client";

import { useState, type ReactNode } from "react";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import Card from "@/app/components/ui/Card";
import type { Tone } from "@/app/components/ui/tone";
import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";
import {
  activationRefusal,
  kitByRole,
  kitGapSentence,
  kitGaps,
  resolveSeasonPalette,
  type CanonToken,
  type SeasonAssetRole,
  type SeasonKit,
} from "@/lib/brand/seasons";
import SeasonEditor from "./SeasonEditor";
import SeasonKitEditor from "./SeasonKitEditor";

/**
 * A season as a BOARD, not a form.
 *
 * The question a season raises is "does this hang together?", and a stack of
 * labelled inputs cannot answer it. So the ground and the role colours are
 * rendered as actual colour, the chop glyph and season logo as images, the
 * motifs and examples as thumbnails, and the lean and voice note as prose at a
 * readable width. Editing opens underneath the board rather than on a screen of
 * its own, so the thing being described stays in view while it is changed.
 *
 * The one place a raw colour is allowed: a swatch's `backgroundColor`. The
 * season's own colour IS the content there. Everything structural is a token.
 */

const SEASON_TONE: Record<SeasonKit["status"], Tone> = {
  active: "success",
  draft: "accent",
  archived: "neutral",
};

/** What each kit row is for, and what its absence means. Shown when empty. */
const ROLE_COPY: Record<SeasonAssetRole, { title: string; empty: string }> = {
  motif: {
    title: "Motifs",
    empty: "No motifs — this season has no visual vocabulary of its own yet.",
  },
  example: {
    title: "Examples",
    empty: "No examples — nothing here answers “what does this season look like?”.",
  },
  texture: {
    title: "Textures",
    empty: "No textures.",
  },
};

export default function SeasonBoard({
  season,
  tokens,
  assets,
  open,
  onToggle,
  onActivate,
  activating,
}: {
  season: SeasonKit;
  tokens: CanonToken[];
  assets: BrandAsset[];
  open: boolean;
  onToggle: () => void;
  onActivate: (overrideReason?: string) => void;
  activating: boolean;
}) {
  const isActive = season.status === "active";
  const palette = resolveSeasonPalette(season.palette, tokens);
  // One call, one rule. The sentence under the title, the refusal on the button
  // and the server's own gate are all this list — see kitGaps.
  const gaps = kitGaps(season, season.kit);
  const gapSentence = kitGapSentence(season.name, gaps);
  const dateWindow = [season.starts_at, season.ends_at].filter(Boolean).join(" → ");

  // The override is a deliberate act, so it takes a step of its own: the button
  // opens the refusal, and only a typed reason gets past it.
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");

  return (
    // The active season is the one in force, and which one that is should never
    // require reading a status chip: it carries the accent ring and the eyebrow,
    // and it sorts first.
    //
    // A RING rather than a border override. `Card` already sets `border-line`,
    // and a second border-colour utility beside it is resolved by stylesheet
    // order rather than className order — the trap `Badge`'s `tone="none"`
    // documents — so the override silently lost. `ring-1 ring-accent` is the
    // pattern ReleasesWorkbench already uses to mark the selected thing.
    <Card className={isActive ? "ring-1 ring-accent" : ""}>
      {isActive && (
        <p className="text-2xs font-semibold uppercase tracking-wide text-accent mb-1.5">
          In force now
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-strong">{season.name}</h3>
        <Badge tone={SEASON_TONE[season.status]}>{season.status}</Badge>
        {dateWindow && <span className="text-2xs text-muted font-mono">{dateWindow}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          {!isActive && (
            // Enabled even when the kit is short, because there IS a way
            // through: the click opens the refusal and the reason field rather
            // than doing nothing. A disabled button would teach the rule by
            // withholding the action, and a gate with no visible escape gets
            // worked around somewhere nobody is looking.
            <button
              type="button"
              className="btn-primary"
              disabled={activating || overriding}
              onClick={() => (gaps.length > 0 ? setOverriding(true) : onActivate())}
            >
              Make active
            </button>
          )}
          <button
            type="button"
            className="btn-secondary"
            aria-expanded={open}
            onClick={onToggle}
          >
            {open ? "Done editing" : "Edit kit"}
          </button>
        </div>
      </div>

      {/* The amber accent box is the house caution pattern — there is no
          `warning` tone in this app. An unfinished kit names every piece it is
          short of, in one sentence, so it cannot look finished. */}
      {gapSentence && (
        <Banner tone="accent" className="mt-3">
          {gapSentence}
        </Banner>
      )}

      {/* The override, after the fact. A season put into force unfinished says
          so on its own board, next to the list of what it was short of — that
          is the entire value of recording a reason rather than hiding the
          check behind a flag. */}
      {season.activation_override_reason && (
        <Banner tone="accent" className="mt-3">
          Put into force before it was finished — “{season.activation_override_reason}”
        </Banner>
      )}

      {/* The refusal, before the fact. Named in full, from the same list, with
          the only way past it directly underneath. */}
      {overriding && !isActive && (
        <div className="mt-3 flex flex-col gap-2 rounded-md border border-line-strong bg-surface-mid p-3">
          <p className="text-sm text-body max-w-prose">{activationRefusal(season.name, gaps)}</p>
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted">Reason</span>
            <input
              className="inp-sm"
              value={reason}
              placeholder="Why this has to go out before the kit is finished"
              aria-label="Override reason"
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <div className="flex flex-wrap gap-2">
            {/* Disabled without a reason, because there is no override without
                one — the route and the column's CHECK both say the same. */}
            <button
              type="button"
              className="btn-primary"
              disabled={activating || !reason.trim()}
              onClick={() => onActivate(reason.trim())}
            >
              Put into force anyway
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={activating}
              onClick={() => {
                setOverriding(false);
                setReason("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <Section title="Palette">
            <div className="grid grid-cols-3 gap-2">
              <Swatch
                label="Ground"
                hex={season.background_hex}
                caption={season.background_hex ?? "not set"}
              />
              {palette.map((role) =>
                role.state === "resolved" ? (
                  <Swatch
                    key={role.role}
                    label={role.role}
                    hex={role.hex}
                    caption={role.name}
                  />
                ) : role.state === "unknown" ? (
                  // A role pointing at a token the canon no longer declares has
                  // to say so. Rendering nothing would hide a season quietly
                  // pointing at a colour that does not exist any more.
                  <Swatch
                    key={role.role}
                    label={role.role}
                    hex={null}
                    tone="danger"
                    caption={`“${role.token}” — not in the canon`}
                  />
                ) : (
                  <Swatch key={role.role} label={role.role} hex={null} caption="not set" />
                ),
              )}
            </div>
          </Section>

          <Section title="Marks">
            <div className="flex flex-wrap gap-3">
              <MarkTile
                label="Chop glyph"
                assetId={season.chop_glyph_asset_id}
                assets={assets}
                // The chop sits on the season ground on a real label, so the
                // tile shows it there: whether the glyph reads against the
                // ground is half of what this board is for.
                ground={season.background_hex}
              />
              <MarkTile
                label="Season logo"
                assetId={season.season_logo_asset_id}
                assets={assets}
                ground={season.background_hex}
              />
            </div>
          </Section>
        </div>

        <div className="flex flex-col gap-4">
          {(["motif", "example", "texture"] as const).map((role) => {
            const items = kitByRole(season.kit, role);
            // Motifs and examples are part of a complete kit, so their absence
            // is worth stating. A texture is optional — an empty row for it
            // would just be noise.
            if (items.length === 0 && role === "texture") return null;
            return (
              <Section key={role} title={ROLE_COPY[role].title} count={items.length}>
                {items.length === 0 ? (
                  <p className="text-2xs text-faint">{ROLE_COPY[role].empty}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {items.map((item) => (
                      <Thumb
                        key={item.asset_id}
                        assetId={item.asset_id}
                        assets={assets}
                        note={item.note}
                      />
                    ))}
                  </div>
                )}
              </Section>
            );
          })}

          <Section title="Cultural lean">
            <Prose
              value={season.cultural_lean}
              empty="Not set — this is quoted verbatim into every artist commission brief."
            />
          </Section>

          <Section title="Voice">
            <Prose
              value={season.voice_note}
              empty="Not set — one or two sentences on how this season sounds."
            />
          </Section>
        </div>
      </div>

      {open && (
        <>
          <SeasonEditor season={season} tokens={tokens} />
          <SeasonKitEditor season={season} assets={assets} />
        </>
      )}
    </Card>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: number;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1.5 min-w-0">
      <div className="flex items-baseline gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-secondary">{title}</h4>
        {count !== undefined && count > 0 && <span className="text-2xs text-faint">{count}</span>}
      </div>
      {children}
    </section>
  );
}

/** Prose at a readable width — the lean and the voice note are read, not scanned. */
function Prose({ value, empty }: { value: string | null; empty: string }) {
  if (!value?.trim()) return <p className="text-2xs text-faint max-w-prose">{empty}</p>;
  return <p className="text-sm text-secondary max-w-prose whitespace-pre-line">{value}</p>;
}

function Swatch({
  label,
  hex,
  caption,
  tone,
}: {
  label: string;
  hex: string | null;
  caption: string;
  tone?: "danger";
}) {
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div
        className={`h-12 rounded-md border ${
          hex ? "border-line-strong" : "border-dashed border-line-strong bg-surface-mid"
        }`}
        // The only raw colour on this page: the season's own colour is the data.
        style={hex ? { backgroundColor: hex } : undefined}
      />
      <span className="text-2xs uppercase tracking-wide text-faint">{label}</span>
      <span className={`text-2xs ${tone === "danger" ? "text-danger" : "text-muted"}`}>
        {caption}
      </span>
    </div>
  );
}

function MarkTile({
  label,
  assetId,
  assets,
  ground,
}: {
  label: string;
  assetId: string | null;
  assets: BrandAsset[];
  ground: string | null;
}) {
  const asset = assets.find((a) => a.id === assetId);
  return (
    <div className="flex flex-col gap-1 w-20">
      <div
        className={`h-20 w-20 rounded-md border grid place-items-center overflow-hidden ${
          assetId ? "border-line-strong" : "border-dashed border-line-strong bg-surface-mid"
        }`}
        style={assetId && ground ? { backgroundColor: ground } : undefined}
      >
        {assetId ? (
          <AssetImage id={assetId} alt={asset?.alt_text ?? label} />
        ) : (
          <span className="text-2xs text-faint">none</span>
        )}
      </div>
      <span className="text-2xs uppercase tracking-wide text-faint">{label}</span>
      <span className="text-2xs text-muted truncate" title={asset?.title ?? undefined}>
        {assetId ? (asset?.title ?? asset?.variant ?? "attached") : "not set"}
      </span>
    </div>
  );
}

function Thumb({
  assetId,
  assets,
  note,
}: {
  assetId: string;
  assets: BrandAsset[];
  note: string | null;
}) {
  const asset = assets.find((a) => a.id === assetId);
  const caption = note ?? asset?.title ?? asset?.variant ?? "";
  return (
    <figure className="w-20">
      <div className="h-20 w-20 rounded-md border border-line-strong bg-surface-mid overflow-hidden grid place-items-center">
        <AssetImage id={assetId} alt={asset?.alt_text ?? caption} />
      </div>
      <figcaption className="mt-1 text-2xs text-muted truncate" title={caption}>
        {caption}
      </figcaption>
    </figure>
  );
}

/** One `<img>` for the whole board, so the lint exemption is stated once. */
function AssetImage({ id, alt }: { id: string; alt: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={assetFileUrl(id)} alt={alt} className="w-full h-full object-contain p-1" />
  );
}
