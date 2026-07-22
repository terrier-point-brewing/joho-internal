"use client";

import { useMemo, useState, type FormEvent } from "react";
import Card from "@/app/components/ui/Card";
import Badge from "@/app/components/ui/Badge";
import Banner from "@/app/components/ui/Banner";
import type { Tone } from "@/app/components/ui/tone";
import { publicUrlFor, type BrandAsset, type BrandAssetKind } from "@/lib/brand/assets";
import { useApproveAsset, useArchiveAsset, useAssets, useUploadAsset } from "./useAssets";

const KINDS: BrandAssetKind[] = ["logo", "wordmark", "chop_glyph", "texture", "icon", "photo"];

const STATUS_TONE: Record<BrandAsset["status"], Tone> = {
  approved: "success",
  draft: "neutral",
  archived: "danger",
};

/**
 * Admin asset library — ops chrome (not a brand surface). Groups approved/
 * draft/archived rows by kind, with an upload form and per-row approve/
 * archive actions. Writes are admin-gated server-side by the API routes;
 * this page assumes it's only reachable by an admin (BrandNav hides the tab
 * for non-admins, same as the canon editor).
 */
export default function AssetsPage() {
  const { data: assets, isLoading, error: loadError } = useAssets();
  const upload = useUploadAsset();
  const approve = useApproveAsset();
  const archive = useArchiveAsset();

  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState<BrandAssetKind>("logo");
  const [variant, setVariant] = useState("default");

  const grouped = useMemo(() => {
    const map = new Map<BrandAssetKind, BrandAsset[]>();
    for (const k of KINDS) map.set(k, []);
    for (const asset of assets ?? []) {
      map.get(asset.kind)?.push(asset);
    }
    return map;
  }, [assets]);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    const formData = new FormData();
    formData.set("file", file);
    formData.set("kind", kind);
    formData.set("variant", variant.trim() || "default");
    await upload.mutateAsync(formData);
    setFile(null);
    setVariant("default");
  }

  const mutationError = upload.error ?? approve.error ?? archive.error;

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (loadError) return <Banner tone="danger">{(loadError as Error).message}</Banner>;

  return (
    <div className="flex flex-col gap-6">
      {mutationError && <Banner tone="danger">{(mutationError as Error).message}</Banner>}

      <Card>
        <form onSubmit={handleUpload} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor="asset-file">
              File
            </label>
            <input
              id="asset-file"
              type="file"
              className="inp"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor="asset-kind">
              Kind
            </label>
            <select
              id="asset-kind"
              className="inp"
              value={kind}
              onChange={(e) => setKind(e.target.value as BrandAssetKind)}
            >
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted" htmlFor="asset-variant">
              Variant
            </label>
            <input
              id="asset-variant"
              className="inp"
              value={variant}
              onChange={(e) => setVariant(e.target.value)}
              placeholder="default"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={!file || upload.isPending}>
            {upload.isPending ? "Uploading…" : "Upload"}
          </button>
        </form>
      </Card>

      {KINDS.map((k) => {
        const items = grouped.get(k) ?? [];
        if (items.length === 0) return null;
        return (
          <div key={k} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold text-primary capitalize">
              {k.replace("_", " ")}
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
              {items.map((asset) => (
                <Card key={asset.id} className="flex flex-col gap-2">
                  <div className="aspect-square bg-surface-mid rounded flex items-center justify-center overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary uploaded asset URLs, not a static import */}
                    <img
                      src={publicUrlFor(asset.storage_path)}
                      alt={`${asset.kind} ${asset.variant}`}
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
                        disabled={approve.isPending}
                        onClick={() => approve.mutate(asset.id)}
                      >
                        Approve
                      </button>
                    )}
                    {asset.status !== "archived" && (
                      <button
                        type="button"
                        className="btn-danger btn-xxs"
                        disabled={archive.isPending}
                        onClick={() => archive.mutate(asset.id)}
                      >
                        Archive
                      </button>
                    )}
                  </div>
                </Card>
              ))}
            </div>
          </div>
        );
      })}

      {assets && assets.length === 0 && (
        <p className="text-sm text-muted">No assets uploaded yet.</p>
      )}
    </div>
  );
}
