"use client";

import { useState } from "react";
import Banner from "@/app/components/ui/Banner";
import { assetFileUrl, type BrandAsset } from "@/lib/brand/assets";
import {
  kitByRole,
  SEASON_ASSET_ROLES,
  type BrandSeasonAsset,
  type SeasonAssetRole,
  type SeasonKit,
} from "@/lib/brand/seasons";
import {
  useAddSeasonAsset,
  useRemoveSeasonAsset,
  useUpdateSeasonAsset,
} from "./useTemplates";

/**
 * The kit's rows — motifs, examples and textures — edited in place on the board.
 *
 * Writes `brand_season_assets`, never `motif_set`: a list that lives in a jsonb
 * document can only be rewritten wholesale, and these have to be ordered,
 * re-roled and removed one at a time.
 *
 * Each control saves on the click rather than into a draft the way the season's
 * own fields do. A membership row is one whole act — added, moved, re-roled or
 * removed — with nothing to accumulate and nothing to cancel.
 */
export default function SeasonKitEditor({
  season,
  assets,
}: {
  season: SeasonKit;
  assets: BrandAsset[];
}) {
  const add = useAddSeasonAsset();
  const update = useUpdateSeasonAsset();
  const remove = useRemoveSeasonAsset();

  // One "add" grid open at a time. Approved assets only — an unapproved asset is
  // one nobody has signed off on, and a season is the last place to smuggle one in.
  const [adding, setAdding] = useState<SeasonAssetRole | null>(null);
  const approved = assets.filter((a) => a.status === "approved");

  const error = add.error ?? update.error ?? remove.error;
  const busy = add.isPending || update.isPending || remove.isPending;

  return (
    <div className="flex flex-col gap-4 mt-3 pt-3 border-t border-line">
      <p className="text-2xs text-faint uppercase tracking-wide">Kit</p>

      {error && <Banner tone="danger">{(error as Error).message}</Banner>}

      {SEASON_ASSET_ROLES.map((role) => {
        const items = kitByRole(season.kit, role);
        const held = new Set(items.map((i) => i.asset_id));
        const available = approved.filter((a) => !held.has(a.id));

        return (
          <section key={role} className="flex flex-col gap-1.5">
            <span className="text-xs text-muted capitalize">
              {role}s{items.length > 0 && ` · ${items.length}`}
            </span>

            {items.map((item, index) => (
              <KitRow
                key={item.asset_id}
                item={item}
                asset={assets.find((a) => a.id === item.asset_id)}
                first={index === 0}
                last={index === items.length - 1}
                busy={busy}
                onMove={(direction) =>
                  update.mutate({
                    seasonId: season.id,
                    asset_id: item.asset_id,
                    role,
                    direction,
                  })
                }
                onRole={(to_role) =>
                  update.mutate({ seasonId: season.id, asset_id: item.asset_id, role, to_role })
                }
                onNote={(note) =>
                  update.mutate({ seasonId: season.id, asset_id: item.asset_id, role, note })
                }
                onRemove={() =>
                  remove.mutate({ seasonId: season.id, asset_id: item.asset_id, role })
                }
              />
            ))}

            <div>
              <button
                type="button"
                className="btn-secondary"
                aria-expanded={adding === role}
                onClick={() => setAdding(adding === role ? null : role)}
              >
                {adding === role ? "Close" : `Add ${role}`}
              </button>
            </div>

            {adding === role &&
              (available.length === 0 ? (
                <p className="text-2xs text-faint">
                  Every approved asset already holds this role. Upload and approve more in Assets.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {available.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      title={`${a.title ?? a.variant} · ${a.kind}`}
                      disabled={busy}
                      className="w-14 h-14 rounded border border-line overflow-hidden hover:border-accent"
                      onClick={() =>
                        add.mutate({ seasonId: season.id, asset_id: a.id, role })
                      }
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
              ))}
          </section>
        );
      })}
    </div>
  );
}

/**
 * One membership row: thumbnail, note, role, order, removal.
 *
 * A row rather than a tile because it holds an `.inp-sm` note field, and a
 * repeated editor row containing a 12px input takes default-size buttons — a
 * 10px `.btn-xxs` beside a 12px control is the adjacency defect §5 names.
 */
function KitRow({
  item,
  asset,
  first,
  last,
  busy,
  onMove,
  onRole,
  onNote,
  onRemove,
}: {
  item: BrandSeasonAsset;
  asset: BrandAsset | undefined;
  first: boolean;
  last: boolean;
  busy: boolean;
  onMove: (direction: "up" | "down") => void;
  onRole: (role: SeasonAssetRole) => void;
  onNote: (note: string) => void;
  onRemove: () => void;
}) {
  const [note, setNote] = useState(item.note ?? "");

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="w-10 h-10 shrink-0 rounded border border-line bg-surface-mid overflow-hidden grid place-items-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={assetFileUrl(item.asset_id)}
          alt={asset?.alt_text ?? asset?.variant ?? "kit asset"}
          className="w-full h-full object-contain"
        />
      </span>

      <span className="text-xs text-body w-36 shrink-0 truncate" title={asset?.title ?? undefined}>
        {asset?.title ?? asset?.variant ?? item.asset_id.slice(0, 8)}
      </span>

      <input
        className="inp-sm flex-1 min-w-40"
        value={note}
        placeholder="Note — what this one is for"
        aria-label="Note"
        onChange={(e) => setNote(e.target.value)}
        // Committed on blur, not on every keystroke: this is a row write, not a
        // draft field, and one request per character is not one.
        onBlur={() => note !== (item.note ?? "") && onNote(note)}
      />

      <select
        className="inp-sm w-28"
        value={item.role}
        aria-label="Role"
        disabled={busy}
        onChange={(e) => onRole(e.target.value as SeasonAssetRole)}
      >
        {SEASON_ASSET_ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>

      <button
        type="button"
        className="btn-secondary"
        aria-label="Move up"
        disabled={busy || first}
        onClick={() => onMove("up")}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn-secondary"
        aria-label="Move down"
        disabled={busy || last}
        onClick={() => onMove("down")}
      >
        ↓
      </button>
      <button type="button" className="btn-danger" disabled={busy} onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
