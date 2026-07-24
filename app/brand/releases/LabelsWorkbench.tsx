"use client";

import { useMemo, useState } from "react";
import PageHeader from "@/app/components/PageHeader";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import TabBar from "@/app/components/TabBar";
import { type Tone } from "@/app/components/ui/tone";
import { publicUrlFor, type BrandAsset } from "@/lib/brand/assets";
import {
  syncNamingCheck,
  type BrandLabel,
  type NamingCheck,
  type Tier2Palette,
} from "@/lib/brand/labels";

type BrandLabelStatus = BrandLabel["status"];
import { useAssets } from "../assets/useAssets";
import {
  useApproveLabel,
  useArchiveLabel,
  useCreateLabel,
  useLabels,
  useUpdateLabel,
} from "./useLabels";

const STATUS_TONE: Record<BrandLabelStatus, Tone> = {
  draft: "accent",
  approved: "success",
  archived: "neutral",
};

type FacetKey = "details" | "naming" | "palette" | "chop";
const FACETS: { key: FacetKey; label: string }[] = [
  { key: "details", label: "Details" },
  { key: "naming", label: "Naming check" },
  { key: "palette", label: "Tier-2 palette" },
  { key: "chop", label: "Chop glyph" },
];

export default function LabelsWorkbench({ criteria }: { criteria: string[] }) {
  const { data: labels = [], isLoading, error } = useLabels();
  const createLabel = useCreateLabel();
  const updateLabel = useUpdateLabel();
  const approveLabel = useApproveLabel();
  const archiveLabel = useArchiveLabel();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const selected = labels.find((l) => l.id === selectedId) ?? null;

  return (
    <div className="flex-1 overflow-auto px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4">
      <PageHeader title="Releases" description="Per-beer labels: story, naming check, Tier-2 palette, and chop." />
      <div className="grid grid-cols-1 lg:grid-cols-[18rem_1fr] gap-4">
      {/* List + create */}
      <div className="flex flex-col gap-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!newName.trim()) return;
            createLabel.mutate(
              { name: newName.trim() },
              { onSuccess: (label) => { setSelectedId(label.id); setNewName(""); } },
            );
          }}
        >
          <input
            className="inp-sm"
            placeholder="New label name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <button type="submit" className="btn-primary btn-xxs" disabled={createLabel.isPending}>
            Add
          </button>
        </form>

        {isLoading && <p className="text-xs text-secondary">Loading…</p>}
        {error && <Banner tone="danger">{(error as Error).message}</Banner>}

        <div className="flex flex-col gap-2">
          {labels.map((label) => (
            <button
              key={label.id}
              type="button"
              onClick={() => setSelectedId(label.id)}
              className={`text-left ${label.id === selectedId ? "ring-1 ring-accent rounded-lg" : ""}`}
            >
              <Card padding="p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-primary truncate">{label.name}</span>
                  <Badge tone={STATUS_TONE[label.status]}>{label.status}</Badge>
                </div>
                {label.subtitle && (
                  <p className="text-2xs text-muted truncate">{label.subtitle}</p>
                )}
              </Card>
            </button>
          ))}
          {labels.length === 0 && !isLoading && (
            <p className="text-xs text-muted">No labels yet.</p>
          )}
        </div>
      </div>

      {/* Editor */}
      {selected ? (
        <LabelEditor
          key={selected.id}
          label={selected}
          criteria={criteria}
          saving={updateLabel.isPending}
          onSave={(patch) => updateLabel.mutate({ id: selected.id, patch })}
          onApprove={() => approveLabel.mutate(selected.id)}
          onArchive={() => archiveLabel.mutate(selected.id)}
        />
      ) : (
        <Card>
          <p className="text-sm text-secondary">Select a label, or add one to begin.</p>
        </Card>
      )}
      </div>
    </div>
  );
}

function LabelEditor({
  label,
  criteria,
  saving,
  onSave,
  onApprove,
  onArchive,
}: {
  label: BrandLabel;
  criteria: string[];
  saving: boolean;
  onSave: (patch: Partial<BrandLabel>) => void;
  onApprove: () => void;
  onArchive: () => void;
}) {
  const [facet, setFacet] = useState<FacetKey>("details");
  const [draft, setDraft] = useState<BrandLabel>(label);
  const chopAssets = useAssets("chop_glyph");

  // Keep the naming check aligned with the current canon criteria.
  const namingResults = useMemo(
    () => syncNamingCheck(criteria, draft.naming_check).results,
    [criteria, draft.naming_check],
  );

  const set = (patch: Partial<BrandLabel>) => setDraft((d) => ({ ...d, ...patch }));
  const setNaming = (results: NamingCheck["results"]) => set({ naming_check: { results } });
  const setPalette = (colors: Tier2Palette["colors"]) => set({ tier2_palette: { colors } });

  return (
    <div className="flex flex-col gap-3 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <TabBar tabs={FACETS} activeKey={facet} onSelect={setFacet} />
        <div className="flex gap-2 shrink-0">
          <button className="btn-secondary btn-xxs" onClick={onArchive}>Archive</button>
          <button className="btn-secondary btn-xxs" onClick={onApprove}>Approve</button>
          <button
            className="btn-primary btn-xxs"
            disabled={saving}
            onClick={() =>
              onSave({
                name: draft.name,
                subtitle: draft.subtitle,
                description: draft.description,
                motif_family: draft.motif_family,
                tier2_palette: { colors: draft.tier2_palette.colors },
                naming_check: { results: namingResults },
                chop_glyph_asset_id: draft.chop_glyph_asset_id,
              })
            }
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <Card>
        {facet === "details" && (
          <div className="flex flex-col gap-3 max-w-lg">
            <Field label="Story title">
              <input className="inp" value={draft.name} onChange={(e) => set({ name: e.target.value })} />
            </Field>
            <Field label="Plain-style subtitle">
              <input className="inp" value={draft.subtitle ?? ""} onChange={(e) => set({ subtitle: e.target.value })} />
            </Field>
            <Field label="Description">
              <textarea className="inp" rows={3} value={draft.description ?? ""} onChange={(e) => set({ description: e.target.value })} />
            </Field>
            <Field label="Motif family">
              <input className="inp" value={draft.motif_family ?? ""} onChange={(e) => set({ motif_family: e.target.value })} />
            </Field>
          </div>
        )}

        {facet === "naming" && (
          <div className="flex flex-col gap-3">
            {criteria.length === 0 && <p className="text-xs text-muted">No naming criteria in the canon.</p>}
            {namingResults.map((r, i) => (
              <div key={r.criterion} className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={r.pass}
                  onChange={(e) => {
                    const next = [...namingResults];
                    next[i] = { ...r, pass: e.target.checked };
                    setNaming(next);
                  }}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-body">{r.criterion}</p>
                  <input
                    className="inp-sm mt-1"
                    placeholder="Note (optional)"
                    value={r.note ?? ""}
                    onChange={(e) => {
                      const next = [...namingResults];
                      next[i] = { ...r, note: e.target.value };
                      setNaming(next);
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {facet === "palette" && (
          <div className="flex flex-col gap-2">
            {draft.tier2_palette.colors.map((c, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#000000"}
                  onChange={(e) => {
                    const next = [...draft.tier2_palette.colors];
                    next[i] = { ...c, hex: e.target.value };
                    setPalette(next);
                  }}
                />
                <input className="inp-sm" placeholder="Name" value={c.name} onChange={(e) => { const n = [...draft.tier2_palette.colors]; n[i] = { ...c, name: e.target.value }; setPalette(n); }} />
                <input className="inp-sm" placeholder="Note" value={c.note ?? ""} onChange={(e) => { const n = [...draft.tier2_palette.colors]; n[i] = { ...c, note: e.target.value }; setPalette(n); }} />
                <button className="btn-danger btn-xxs" onClick={() => setPalette(draft.tier2_palette.colors.filter((_, j) => j !== i))}>Remove</button>
              </div>
            ))}
            <button
              className="btn-secondary btn-xxs self-start"
              onClick={() => setPalette([...draft.tier2_palette.colors, { name: "", hex: "#26355d" }])}
            >
              Add color
            </button>
          </div>
        )}

        {facet === "chop" && (
          <ChopPicker
            assets={chopAssets.data ?? []}
            selectedId={draft.chop_glyph_asset_id}
            onSelect={(id) => set({ chop_glyph_asset_id: id })}
          />
        )}
      </Card>
    </div>
  );
}

function ChopPicker({
  assets,
  selectedId,
  onSelect,
}: {
  assets: BrandAsset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const approved = assets.filter((a) => a.status === "approved");
  if (approved.length === 0) {
    return <p className="text-xs text-muted">No approved chop-glyph assets yet — upload one in Assets.</p>;
  }
  return (
    <div className="flex flex-wrap gap-3">
      <button
        type="button"
        onClick={() => onSelect(null)}
        className={`w-16 h-16 rounded border grid place-items-center text-2xs ${selectedId === null ? "border-accent" : "border-line"}`}
      >
        None
      </button>
      {approved.map((a) => (
        <button
          key={a.id}
          type="button"
          onClick={() => onSelect(a.id)}
          className={`w-16 h-16 rounded border overflow-hidden ${selectedId === a.id ? "border-accent" : "border-line"}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={publicUrlFor(a.storage_path)} alt={a.variant} className="w-full h-full object-contain" />
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-secondary">{label}</span>
      {children}
    </label>
  );
}
