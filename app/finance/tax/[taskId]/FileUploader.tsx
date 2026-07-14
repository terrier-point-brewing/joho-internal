"use client";

/**
 * Free-form confirmation-file uploader for a tax task. No prescribed
 * categories — the user picks a file, types whatever free-text label they
 * want ("Payment confirmation", "Filed return PDF", etc.), and uploads as
 * many as needed. Wraps the Task 13 API:
 *   POST   /api/tax/tasks/[id]/files            (multipart: file, label)
 *   GET    /api/tax/tasks/[id]/files            (list)
 *   GET    /api/tax/tasks/[id]/files/[fileId]   (signed download URL)
 *   DELETE /api/tax/tasks/[id]/files/[fileId]
 *
 * `readOnly` (set once the parent task is completed) hides the upload form
 * and the per-file Delete action — a closed task's file list is
 * download-only.
 */
import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Banner from "@/app/components/ui/Banner";
import { queryKeys } from "@/lib/query-keys";
import { fetchJson } from "@/app/production/hooks/queries";
import type { TaxTaskFile } from "@/lib/tax/types";

export default function FileUploader({ taskId, readOnly = false }: { taskId: string; readOnly?: boolean }) {
  const qc = useQueryClient();
  const filesQuery = useQuery({
    queryKey: queryKeys.tax.taskFiles(taskId),
    queryFn: () => fetchJson<TaxTaskFile[]>(`/api/tax/tasks/${taskId}/files`),
  });
  const files = filesQuery.data ?? [];

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [label, setLabel] = useState("");
  const [uploading, setUploading] = useState(false);
  const [busyFileId, setBusyFileId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleUpload() {
    if (!selectedFile || uploading) return;

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append("file", selectedFile);
      formData.append("label", label);
      const res = await fetch(`/api/tax/tasks/${taskId}/files`, { method: "POST", body: formData });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Upload failed (${res.status})`);
      }
      await qc.invalidateQueries({ queryKey: queryKeys.tax.taskFiles(taskId) });
      setSelectedFile(null);
      setLabel("");
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  async function handleDownload(file: TaxTaskFile) {
    setBusyFileId(file.id);
    setError(null);
    try {
      const { url } = await fetchJson<{ url: string }>(`/api/tax/tasks/${taskId}/files/${file.id}`);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't get a download link.");
    } finally {
      setBusyFileId(null);
    }
  }

  async function handleDelete(file: TaxTaskFile) {
    if (!window.confirm(`Delete "${file.file_name}"? This can't be undone.`)) return;
    setBusyFileId(file.id);
    setError(null);
    try {
      const res = await fetch(`/api/tax/tasks/${taskId}/files/${file.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? `Delete failed (${res.status})`);
      }
      await qc.invalidateQueries({ queryKey: queryKeys.tax.taskFiles(taskId) });
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
            <label className="btn-secondary btn-xxs cursor-pointer">
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
              placeholder="e.g. Payment confirmation"
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
            className="btn-secondary btn-xxs"
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
        <p className="text-xs text-faint">No files uploaded yet.</p>
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
                    onClick={() => handleDelete(file)}
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
    </div>
  );
}
