"use client";

import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import { useVersions } from "../useCanonEditor";

/** Read-only canon version history — published + archived rows, newest first. */
export default function CanonHistoryPage() {
  const { data: versions = [], isLoading, error } = useVersions();

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (error) return <Banner tone="danger">{(error as Error).message}</Banner>;

  return (
    <Card padding="" className="overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-muted text-xs uppercase tracking-wide">
            <th className="text-left px-4 py-3 font-medium">Version</th>
            <th className="text-left px-4 py-3 font-medium">Status</th>
            <th className="text-left px-4 py-3 font-medium">Published</th>
            <th className="text-left px-4 py-3 font-medium">Changelog</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => (
            <tr key={v.id} className="border-b border-line/50 last:border-0">
              <td className="px-4 py-3 text-strong">{v.version_label}</td>
              <td className="px-4 py-3">
                <Badge tone={v.status === "published" ? "success" : "neutral"}>{v.status}</Badge>
              </td>
              <td className="px-4 py-3 text-muted">
                {v.published_at ? new Date(v.published_at).toLocaleString() : "—"}
              </td>
              <td className="px-4 py-3 text-muted max-w-md truncate">{v.changelog ?? "—"}</td>
            </tr>
          ))}
          {versions.length === 0 && (
            <tr>
              <td colSpan={4} className="px-4 py-6 text-center text-faint text-sm">
                No versions published yet
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </Card>
  );
}
