"use client";

import { useMemo, useState, type FormEvent } from "react";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import type { Tone } from "@/app/components/ui/tone";
import { assetFileUrl, type BrandAsset, type BrandAssetKind } from "@/lib/brand/assets";
import {
  useApproveAsset,
  useArchiveAsset,
  useAssets,
  useUploadAsset,
} from "../assets/useAssets";

// The three identity marks and their Assets-library kinds (the mark spec calls
// the chop "chop"; the asset kind is "chop_glyph").
const MARK_KINDS: { kind: BrandAssetKind; label: string }[] = [
  { kind: "wordmark", label: "Wordmark" },
  { kind: "logo", label: "Logo" },
  { kind: "chop_glyph", label: "Chop" },
];

const STATUS_TONE: Record<BrandAsset["status"], Tone> = {
  approved: "success",
  draft: "neutral",
  archived: "danger",
};

/**
 * Admin Marks editor: upload/approve/archive the wordmark, logo, and chop
 * artifacts directly (the same Assets API the Assets tab uses — no separate
 * store). Per-mark specifications (the spec sheets) are edited as canon JSON
 * via the Content editor on the Guide tab.
 */
export default function MarksEditor() {
  const { data: assets, isLoading, error: loadError } = useAssets();
  const upload = useUploadAsset();
  const approve = useApproveAsset();
  const archive = useArchiveAsset();

  const byKind = useMemo(() => {
    const map = new Map<BrandAssetKind, BrandAsset[]>();
    for (const { kind } of MARK_KINDS) map.set(kind, []);
    for (const asset of assets ?? []) {
      if (map.has(asset.kind)) map.get(asset.kind)!.push(asset);
    }
    return map;
  }, [assets]);

  const mutationError = upload.error ?? approve.error ?? archive.error;

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (loadError) return <Banner tone="danger">{(loadError as Error).message}</Banner>;

  return (
    <div className="flex flex-col gap-6">
      <Banner tone="info">
        Upload identity artwork here, then attach it to a specific cut in the spec-sheet editor
        below. Upload one file per format &mdash; SVG for screen, PNG where a vector won&rsquo;t
        do, PDF for print &mdash; and use the variant name to tell cuts apart
        (&ldquo;horizontal&rdquo;, &ldquo;stacked&rdquo;). A cut can carry several files, and the
        guide offers each as its own download.
      </Banner>
      {mutationError && <Banner tone="danger">{(mutationError as Error).message}</Banner>}

      {MARK_KINDS.map(({ kind, label }) => (
        <MarkKindEditor
          key={kind}
          kind={kind}
          label={label}
          assets={byKind.get(kind) ?? []}
          uploading={upload.isPending}
          approving={approve.isPending}
          archiving={archive.isPending}
          onUpload={(formData) => upload.mutate(formData)}
          onApprove={(id) => approve.mutate(id)}
          onArchive={(id) => archive.mutate(id)}
        />
      ))}
    </div>
  );
}

function MarkKindEditor({
  kind,
  label,
  assets,
  uploading,
  approving,
  archiving,
  onUpload,
  onApprove,
  onArchive,
}: {
  kind: BrandAssetKind;
  label: string;
  assets: BrandAsset[];
  uploading: boolean;
  approving: boolean;
  archiving: boolean;
  onUpload: (formData: FormData) => void;
  onApprove: (id: string) => void;
  onArchive: (id: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [variant, setVariant] = useState("default");
  const [altText, setAltText] = useState("");

  function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.set("file", file);
    formData.set("kind", kind);
    formData.set("variant", variant.trim() || "default");
    // Marks are pure imagery with no adjacent prose, so the alt text written
    // here is the only description a screen reader ever gets for them.
    if (altText.trim()) formData.set("alt_text", altText.trim());
    onUpload(formData);
    setFile(null);
    setVariant("default");
    setAltText("");
  }

  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-primary">{label}</h3>

      <Card>
        <form onSubmit={handleUpload} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor={`mark-file-${kind}`}>
              File
            </label>
            <input
              id={`mark-file-${kind}`}
              type="file"
              className="inp-sm"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor={`mark-variant-${kind}`}>
              Variant
            </label>
            <input
              id={`mark-variant-${kind}`}
              className="inp-sm"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="default"
            />
          </div>
          <div className="flex flex-col gap-1 flex-1 min-w-40">
            <label className="text-xs text-muted" htmlFor={`mark-alt-${kind}`}>
              Alt text
            </label>
            <input
              id={`mark-alt-${kind}`}
              className="inp-sm"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder="Describe the mark…"
            />
          </div>
          <button type="submit" className="btn-primary btn-xxs" disabled={!file || uploading}>
            {uploading ? "Uploading…" : "Upload"}
          </button>
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
                  alt={`${label} ${asset.variant}`}
                  className="max-h-full max-w-full object-contain"
                />
              </div>
              <div className="flex items-center justify-between gap-1">
                <span className="text-xs text-secondary truncate">{asset.variant}</span>
                <Badge tone={STATUS_TONE[asset.status]}>{asset.status}</Badge>
              </div>
              <div className="flex gap-1">
                {asset.status !== "approved" && (
                  <button
                    type="button"
                    className="btn-secondary btn-xxs"
                    disabled={approving}
                    onClick={() => onApprove(asset.id)}
                  >
                    Approve
                  </button>
                )}
                {asset.status !== "archived" && (
                  <button
                    type="button"
                    className="btn-danger btn-xxs"
                    disabled={archiving}
                    onClick={() => onArchive(asset.id)}
                  >
                    Archive
                  </button>
                )}
              </div>
            </Card>
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted">No {label.toLowerCase()} uploaded yet.</p>
      )}
    </div>
  );
}
