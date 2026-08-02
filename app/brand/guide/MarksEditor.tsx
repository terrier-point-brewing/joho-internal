"use client";

import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import type { Tone } from "@/app/components/ui/tone";
import type { BrandCanon } from "@/lib/brand/canon.types";
import {
  assetFileUrl,
  MARK_SHAPES,
  type BrandAsset,
  type BrandAssetKind,
  type MarkFacets,
  type MarkShape,
} from "@/lib/brand/assets";
import { useSeasons } from "@/app/brand/templates/useTemplates";
import {
  useApproveAsset,
  useArchiveAsset,
  useAssets,
  useUpdateAssetMeta,
  useUploadAsset,
} from "../assets/useAssets";

const STATUS_TONE: Record<BrandAsset["status"], Tone> = {
  approved: "success",
  draft: "neutral",
  archived: "danger",
};

const SHAPE_LABEL: Record<MarkShape, string> = {
  square: "Square",
  rectangular: "Rectangular",
  other: "Irregular",
};

/** The facet fields, empty. Shared by the upload form and the per-asset editor. */
const BLANK_FACETS: Required<MarkFacets> = {
  season_id: null,
  description: null,
  shape: null,
  color_treatment: null,
  background: null,
};

type Draft = {
  variant: string;
  title: string;
  alt_text: string;
} & Required<MarkFacets>;

const BLANK_DRAFT: Draft = { variant: "", title: "", alt_text: "", ...BLANK_FACETS };

/**
 * Admin Marks editor: the wordmark variations and the season's chops.
 *
 * Uploads go straight to the same Assets API the Assets tab uses — no separate
 * store — but they carry the facets the guide's cards are built from, because
 * an upload with no season and no description produces a card that says nothing.
 * Those facets stay editable afterwards: every asset uploaded before this
 * existed has none, and re-uploading a file to describe it is not a reasonable
 * ask.
 *
 * Logos are absent deliberately. The Marks tab no longer shows a Logos section;
 * the `logo` asset kind still exists and is managed from the Assets tab.
 *
 * The written rules — usage, clearspace, the one rule, the chop's own
 * specification — are canon, and are edited below this by MarksFacet/ChopFields.
 */
export default function MarksEditor({ draft }: { draft?: BrandCanon }) {
  // Ink and ground name brand colors, so the pickers offer the palette that is
  // actually in the draft rather than a list hardcoded here that goes stale the
  // first time a color is renamed.
  const paletteNames = useMemo(() => (draft?.palette ?? []).map((c) => c.name), [draft?.palette]);

  const { data: assets, isLoading, error: loadError } = useAssets();
  const upload = useUploadAsset();
  const approve = useApproveAsset();
  const archive = useArchiveAsset();
  const updateMeta = useUpdateAssetMeta();

  // Seasons are gated on brand.templates, which a brand-guide admin may not
  // hold. A failure here costs the season picker, not the whole editor.
  const { data: seasons, error: seasonError } = useSeasons();

  const byKind = useMemo(() => {
    const wordmarks: BrandAsset[] = [];
    const chops: BrandAsset[] = [];
    for (const asset of assets ?? []) {
      if (asset.kind === "wordmark") wordmarks.push(asset);
      else if (asset.kind === "chop_glyph") chops.push(asset);
    }
    return { wordmarks, chops };
  }, [assets]);

  const mutationError = upload.error ?? approve.error ?? archive.error ?? updateMeta.error;

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (loadError) return <Banner tone="danger">{(loadError as Error).message}</Banner>;

  const shared = {
    seasons: seasons ?? [],
    paletteNames,
    busy: upload.isPending || approve.isPending || archive.isPending || updateMeta.isPending,
    onUpload: (formData: FormData) => upload.mutate(formData),
    onApprove: (id: string) => approve.mutate(id),
    onArchive: (id: string) => archive.mutate(id),
    onSaveMeta: (id: string, meta: MarkFacets & { title?: string; alt_text?: string }) =>
      updateMeta.mutate({ id, ...meta }),
  };

  return (
    <div className="flex flex-col gap-6">
      {mutationError && <Banner tone="danger">{(mutationError as Error).message}</Banner>}

      <MarkKindEditor
        {...shared}
        kind="wordmark"
        label="Wordmark variations"
        blurb="One drawing, many cuts. Every variation is the same wordmark — say how it differs (proportion, ink, ground) and when to reach for it. Upload the SVG and the PNG of a variation under the SAME variation slug and the guide puts them on one card with a switch between them."
        assets={byKind.wordmarks}
      />

      <MarkKindEditor
        {...shared}
        kind="chop_glyph"
        label="Chops"
        blurb="Cut per season against the chop specification below — same color, same frame, different content. Leave the season unset for the generic chop every season falls back to. Upload SVG: a chop is placed at label scale, and a raster will not hold."
        assets={byKind.chops}
        seasonError={!!seasonError}
      />
    </div>
  );
}

function MarkKindEditor({
  kind,
  label,
  blurb,
  assets,
  seasons,
  paletteNames,
  busy,
  seasonError,
  onUpload,
  onApprove,
  onArchive,
  onSaveMeta,
}: {
  kind: BrandAssetKind;
  label: string;
  blurb: string;
  assets: BrandAsset[];
  seasons: { id: string; name: string }[];
  paletteNames: string[];
  busy: boolean;
  seasonError?: boolean;
  onUpload: (formData: FormData) => void;
  onApprove: (id: string) => void;
  onArchive: (id: string) => void;
  onSaveMeta: (id: string, meta: MarkFacets & { title?: string; alt_text?: string }) => void;
}) {
  const isChop = kind === "chop_glyph";
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<Draft>(BLANK_DRAFT);
  const [editing, setEditing] = useState<string | null>(null);

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.set("file", file);
    formData.set("kind", kind);
    formData.set("variant", draft.variant.trim() || "default");
    for (const [field, value] of Object.entries(draft)) {
      if (field === "variant" || !value) continue;
      formData.set(field, String(value));
    }
    onUpload(formData);
    setFile(null);
    setDraft(BLANK_DRAFT);
  }

  const seasonName = (id: string | null | undefined) =>
    seasons.find((s) => s.id === id)?.name ?? null;

  return (
    <div className="flex flex-col gap-2">
      <div>
        <h3 className="text-sm font-semibold text-primary">{label}</h3>
        <p className="text-xs text-muted mt-0.5 max-w-3xl">{blurb}</p>
      </div>

      {isChop && seasonError && (
        <Banner tone="accent">
          Seasons could not be loaded — you need the brand.templates grant to file a chop under one.
          Chops uploaded now will be generic, and can be re-filed later.
        </Banner>
      )}

      <Card>
        <form onSubmit={handleUpload} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="File" htmlFor={`mark-file-${kind}`}>
              <input
                id={`mark-file-${kind}`}
                type="file"
                className="inp-sm"
                accept={isChop ? ".svg,image/svg+xml" : undefined}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </Field>
            <Field
              label={isChop ? "Chop slug" : "Variation slug"}
              htmlFor={`mark-variant-${kind}`}
              hint={isChop ? undefined : "Same slug = same card"}
            >
              <input
                id={`mark-variant-${kind}`}
                className="inp-sm"
                value={draft.variant}
                onChange={(e) => setDraft({ ...draft, variant: e.target.value })}
                placeholder={isChop ? "lantern" : "square-paper"}
              />
            </Field>
            <Field label="Label" htmlFor={`mark-title-${kind}`} grow>
              <input
                id={`mark-title-${kind}`}
                className="inp-sm"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                placeholder={isChop ? "Sky lantern" : "Square · Paper on Indigo"}
              />
            </Field>
          </div>

          <FacetFields
            idPrefix={`new-${kind}`}
            isChop={isChop}
            draft={draft}
            seasons={seasons}
            paletteNames={paletteNames}
            onChange={(patch) => setDraft({ ...draft, ...patch })}
          />

          <div className="flex items-end gap-3">
            <Field label="Alt text" htmlFor={`mark-alt-${kind}`} grow>
              <input
                id={`mark-alt-${kind}`}
                className="inp-sm"
                value={draft.alt_text}
                onChange={(e) => setDraft({ ...draft, alt_text: e.target.value })}
                placeholder="Describe the image for a screen reader…"
              />
            </Field>
            <button type="submit" className="btn-primary btn-xxs" disabled={!file || busy}>
              {busy ? "Working…" : "Upload"}
            </button>
          </div>
        </form>
      </Card>

      {assets.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {assets.map((asset) => (
            <Card key={asset.id} className="flex flex-col gap-2">
              <div className="aspect-square bg-surface-mid rounded flex items-center justify-center overflow-hidden">
                {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary uploaded asset URLs, not a static import */}
                <img
                  src={assetFileUrl(asset.id)}
                  alt={asset.alt_text || `${label} ${asset.variant}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>

              <div className="flex items-center justify-between gap-1">
                <span className="text-xs text-secondary truncate" title={asset.variant}>
                  {asset.title || asset.variant}
                </span>
                <Badge tone={STATUS_TONE[asset.status]}>{asset.status}</Badge>
              </div>

              <p className="text-2xs text-muted">
                {asset.format.toUpperCase()} ·{" "}
                {isChop
                  ? (seasonName(asset.season_id) ?? "Generic")
                  : [
                      asset.shape ? SHAPE_LABEL[asset.shape] : null,
                      asset.color_treatment,
                      asset.background?.toLowerCase() === "none" ? "no ground" : asset.background,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "no facets set"}
              </p>

              <div className="flex flex-wrap gap-1">
                {asset.status !== "approved" && (
                  <button
                    type="button"
                    className="btn-secondary btn-xxs"
                    disabled={busy}
                    onClick={() => onApprove(asset.id)}
                  >
                    Approve
                  </button>
                )}
                {asset.status !== "archived" && (
                  <button
                    type="button"
                    className="btn-danger btn-xxs"
                    disabled={busy}
                    onClick={() => onArchive(asset.id)}
                  >
                    Archive
                  </button>
                )}
                <button
                  type="button"
                  className="btn-secondary btn-xxs"
                  aria-expanded={editing === asset.id}
                  onClick={() => setEditing(editing === asset.id ? null : asset.id)}
                >
                  {editing === asset.id ? "Close" : "Details"}
                </button>
              </div>

              {editing === asset.id && (
                <AssetDetailsForm
                  asset={asset}
                  isChop={isChop}
                  seasons={seasons}
                  paletteNames={paletteNames}
                  busy={busy}
                  onSave={(meta) => {
                    onSaveMeta(asset.id, meta);
                    setEditing(null);
                  }}
                />
              )}
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">No {label.toLowerCase()} uploaded yet.</p>
      )}
    </div>
  );
}

/** Re-files an already-uploaded asset. Same fields as the upload form. */
function AssetDetailsForm({
  asset,
  isChop,
  seasons,
  paletteNames,
  busy,
  onSave,
}: {
  asset: BrandAsset;
  isChop: boolean;
  seasons: { id: string; name: string }[];
  paletteNames: string[];
  busy: boolean;
  onSave: (meta: MarkFacets & { title: string; alt_text: string }) => void;
}) {
  const [draft, setDraft] = useState<Draft>({
    variant: asset.variant,
    title: asset.title ?? "",
    alt_text: asset.alt_text ?? "",
    season_id: asset.season_id ?? null,
    description: asset.description ?? null,
    shape: asset.shape ?? null,
    color_treatment: asset.color_treatment ?? null,
    background: asset.background ?? null,
  });

  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2">
      {/* The variant slug is deliberately not editable here: it is what groups
          a variation's files onto one card, and silently re-keying one file of
          a pair would split the card in two. Re-upload to re-file. */}
      <Field label="Label" htmlFor={`edit-title-${asset.id}`}>
        <input
          id={`edit-title-${asset.id}`}
          className="inp-sm"
          value={draft.title}
          onChange={(e) => setDraft({ ...draft, title: e.target.value })}
        />
      </Field>

      <FacetFields
        idPrefix={`edit-${asset.id}`}
        isChop={isChop}
        draft={draft}
        seasons={seasons}
        paletteNames={paletteNames}
        stacked
        onChange={(patch) => setDraft({ ...draft, ...patch })}
      />

      <Field label="Alt text" htmlFor={`edit-alt-${asset.id}`}>
        <input
          id={`edit-alt-${asset.id}`}
          className="inp-sm"
          value={draft.alt_text}
          onChange={(e) => setDraft({ ...draft, alt_text: e.target.value })}
        />
      </Field>

      <button
        type="button"
        className="btn-primary btn-xxs self-start"
        disabled={busy}
        onClick={() =>
          onSave({
            title: draft.title,
            alt_text: draft.alt_text,
            description: draft.description,
            season_id: draft.season_id,
            shape: draft.shape,
            color_treatment: draft.color_treatment,
            background: draft.background,
          })
        }
      >
        Save details
      </button>
    </div>
  );
}

/**
 * The facets themselves — season and content for a chop, the three variation
 * axes for a wordmark.
 *
 * Ink and ground are free text backed by a datalist of the current palette
 * rather than a `<select>`: the palette is canon data admins edit, and a fixed
 * list here would go stale the first time a color is renamed. Ground also
 * accepts "None", which is not a color.
 */
function FacetFields({
  idPrefix,
  isChop,
  draft,
  seasons,
  paletteNames,
  stacked,
  onChange,
}: {
  idPrefix: string;
  isChop: boolean;
  draft: Draft;
  seasons: { id: string; name: string }[];
  paletteNames: string[];
  stacked?: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const inkList = `${idPrefix}-inks`;
  const groundList = `${idPrefix}-grounds`;

  return (
    <>
      <div className={stacked ? "flex flex-col gap-2" : "flex flex-wrap items-end gap-3"}>
        {isChop ? (
          <Field label="Season" htmlFor={`${idPrefix}-season`}>
            <select
              id={`${idPrefix}-season`}
              className="inp-sm"
              value={draft.season_id ?? ""}
              onChange={(e) => onChange({ season_id: e.target.value || null })}
            >
              <option value="">Generic (seasonless)</option>
              {seasons.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <>
            <Field label="Shape" htmlFor={`${idPrefix}-shape`}>
              <select
                id={`${idPrefix}-shape`}
                className="inp-sm"
                value={draft.shape ?? ""}
                onChange={(e) => onChange({ shape: (e.target.value || null) as MarkShape | null })}
              >
                <option value="">—</option>
                {MARK_SHAPES.map((s) => (
                  <option key={s} value={s}>
                    {SHAPE_LABEL[s]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Ink" htmlFor={`${idPrefix}-ink`}>
              <input
                id={`${idPrefix}-ink`}
                className="inp-sm"
                list={inkList}
                value={draft.color_treatment ?? ""}
                onChange={(e) => onChange({ color_treatment: e.target.value || null })}
                placeholder="Indigo"
              />
              <datalist id={inkList}>
                {paletteNames.map((name) => (
                  <option key={name} value={name} />
                ))}
                <option value="Two-color" />
              </datalist>
            </Field>
            <Field label="Ground" htmlFor={`${idPrefix}-ground`}>
              <input
                id={`${idPrefix}-ground`}
                className="inp-sm"
                list={groundList}
                value={draft.background ?? ""}
                onChange={(e) => onChange({ background: e.target.value || null })}
                placeholder="None"
              />
              <datalist id={groundList}>
                <option value="None" />
                {paletteNames.map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </Field>
          </>
        )}
      </div>

      <Field
        label={isChop ? "Content" : "When to use it"}
        htmlFor={`${idPrefix}-description`}
        grow
      >
        <input
          id={`${idPrefix}-description`}
          className="inp-sm"
          value={draft.description ?? ""}
          onChange={(e) => onChange({ description: e.target.value || null })}
          placeholder={
            isChop
              ? "What the glyph depicts — e.g. a sky lantern, seal script 灯"
              : "Where this variation belongs — e.g. narrow headers and app icons"
          }
        />
      </Field>
    </>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  grow,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  grow?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`flex flex-col gap-1 ${grow ? "flex-1 min-w-40" : ""}`}>
      <label className="text-xs text-muted" htmlFor={htmlFor}>
        {label}
        {hint && <span className="text-faint"> · {hint}</span>}
      </label>
      {children}
    </div>
  );
}
