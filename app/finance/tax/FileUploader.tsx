"use client";

/**
 * Free-form file uploader for the tax module, generic over which file
 * collection it manages via `apiBase`/`queryKey`:
 *   - a task's confirmation files (`/api/tax/tasks/[id]/files`, CompletePanel)
 *   - a party's filing-form templates (`/api/tax/parties/[key]/form-files`,
 *     Settings → Tax Filing; listed read-only on the task worksheet)
 * The user picks a file, types whatever free-text label they want ("Payment
 * confirmation", "Prefilled B-C-710", etc.), and uploads as many as needed.
 * The API contract is the same for both collections:
 *   POST   {apiBase}            (multipart: file, label)
 *   GET    {apiBase}            (list)
 *   GET    {apiBase}/[fileId]   (signed download URL)
 *   DELETE {apiBase}/[fileId]
 *
 * `readOnly` (a completed task, or a task's view of the party templates)
 * hides the upload form and the per-file Delete action — the list is
 * download-only.
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import Banner from "@/app/components/ui/Banner";
import ConfirmDialog from "@/app/components/ui/ConfirmDialog";
import { fetchJson } from "@/app/production/hooks/queries";

/** The fields this component renders/acts on — both TaxTaskFile and
 * TaxFormFile satisfy it. */
interface FileRow {
  id: string;
  file_name: string;
  label: string | null;
}

export default function FileUploader({
  apiBase,
  queryKey,
  labelPlaceholder = "e.g. Payment confirmation",
  emptyText = "No files uploaded yet.",
  readOnly = false,
}: {
  apiBase: string;
  queryKey: QueryKey;
  labelPlaceholder?: string;
  emptyText?: string;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const filesQuery = useQuery({
    queryKey,
    queryFn: () => fetchJson<FileRow[]>(apiBase),
  });
  const files = filesQuery.data ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FileRow | null>(null);

  async function handleUpload() {
    if (!selectedFile || uploading) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("label", label);
      const res = await fetch(apiBase, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }
      await qc.invalidateQueries({ queryKey });
      setSelectedFile(null);
      setLabel("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDownload(file: FileRow) {
    setBusyFileId(file.id);
    setError(null);
    try {
      const { url } = await fetchJson<{ url: string }>(`${apiBase}/${file.id}`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a download link.");
    } finally {
      setBusyFileId(null);
    }
  }

  async function runDelete(file: FileRow) {
    setBusyFileId(file.id);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      await qc.invalidateQueries({ queryKey });
      setDeleting(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete failed.");
    } finally {
      setBusyFileId(null);
    }
  }

  return (
    <div className="space-y-3">
      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="flex items-center gap-2 shrink-0">
            {/* `relative` is load-bearing, not cosmetic: `sr-only` makes the
                input `position: absolute`, so without a positioned ancestor
                its containing block is the initial one — the app shell pins
                `<body>` to `h-screen overflow-hidden` and scrolls an inner
                div, so the input lays out ~2000px down a viewport-height,
                un-scrollable root. Focusing it (which the browser does when
                the file dialog opens) then scrolls the ROOT to reach it,
                pushing every pixel of the app off-screen with no way to
                scroll back. Anchoring it to the label keeps the scroll inside
                the real scroll container. */}
            <label className="btn-secondary cursor-pointer relative">
              Choose File
              <input
                ref={fileInputRef}
                type="file"
                className="sr-only"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <span className="text-xs text-faint max-w-40 truncate">{selectedFile?.name ?? "No file chosen"}</span>
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="block text-xs text-secondary mb-1">Label</label>
            <input
              type="text"
              className="inp-sm w-full"
              placeholder={labelPlaceholder}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleUpload();
                }
              }}
            />
          </div>
          <button
            type="button"
            className="btn-secondary"
            onClick={handleUpload}
            disabled={!selectedFile || uploading}
          >
            {uploading ? "Uploading…" : "Upload"}
          </button>
        </div>
      )}

      {error && <Banner tone="danger">{error}</Banner>}

      {filesQuery.isLoading ? (
        <p className="text-xs text-faint">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="text-xs text-faint">{emptyText}</p>
      ) : (
        <ul className="border border-line rounded-lg divide-y divide-line/60">
          {files.map((file) => (
            <li key={file.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <p className="text-body truncate">{file.file_name}</p>
                {file.label && <p className="text-xs text-faint truncate">{file.label}</p>}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  className="btn-secondary btn-xxs"
                  onClick={() => handleDownload(file)}
                  disabled={busyFileId === file.id}
                >
                  Download
                </button>
                {!readOnly && (
                  <button
                    type="button"
                    className="btn-danger btn-xxs"
                    onClick={() => setDeleting(file)}
                    disabled={busyFileId === file.id}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleting && (
        <ConfirmDialog
          title="Delete file?"
          message={`Delete "${deleting.file_name}"? This can't be undone.`}
          confirmLabel="Delete"
          tone="danger"
          busy={busyFileId === deleting.id}
          onConfirm={() => runDelete(deleting)}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
