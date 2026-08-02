"use client";

import Card from "@/app/components/ui/Card";
import Banner from "@/app/components/ui/Banner";
import Badge from "@/app/components/ui/Badge";
import type { Tone } from "@/app/components/ui/tone";
import { GUIDE_SECTIONS, type GuideSectionKey } from "@/lib/brand/guideIntros";
import type { ChangeEntry } from "@/lib/brand/diffCanon";
import { useVersions, type VersionRow } from "./useCanonEditor";

const SECTION_TITLES: Record<GuideSectionKey | "other", string> = {
  ethos: "Ethos",
  voice: "Voice",
  visual: "Visual Identity",
  color: "Color",
  type: "Type",
  marks: "Marks",
  release: "Release Design",
  agent: "Agent Rules",
  other: "Other",
};

const KIND_TONE: Record<ChangeEntry["kind"], Tone> = {
  added: "success",
  removed: "danger",
  changed: "info",
};

/** Groups a version's entries by subtab, in guide order. */
function groupBySection(entries: ChangeEntry[]): [string, ChangeEntry[]][] {
  const order: (GuideSectionKey | "other")[] = [...GUIDE_SECTIONS, "other"];
  return order
    .map((section) => [SECTION_TITLES[section], entries.filter((e) => e.section === section)] as [string, ChangeEntry[]])
    .filter(([, list]) => list.length > 0);
}

/** The one-line summary shown on a collapsed row. */
function summarise(version: VersionRow): string {
  const entries = version.change_entries;
  // Pre-20260902 rows have no structured entries — fall back to their text.
  if (!entries) return version.changelog?.split("\n")[0] ?? "—";
  if (entries.length === 0) return "No content changes";

  const sections = new Set(entries.map((e) => SECTION_TITLES[e.section]));
  return `${entries.length} ${entries.length === 1 ? "change" : "changes"} across ${[...sections].join(", ")}`;
}

function VersionRowItem({ version }: { version: VersionRow }) {
  const groups = version.change_entries ? groupBySection(version.change_entries) : [];

  return (
    <div className="border-b border-line last:border-0">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 px-4 pt-3">
        <span className="text-strong text-sm font-medium w-12 shrink-0">
          {version.version_label}
        </span>
        <Badge tone={version.status === "published" ? "success" : "neutral"}>
          {version.status}
        </Badge>
        <span className="text-muted text-xs">
          {version.published_at ? new Date(version.published_at).toLocaleString() : "—"}
        </span>
      </div>

      <div className="px-4 py-3">
        {groups.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-sm text-secondary">
              {summarise(version)}
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              {groups.map(([title, list]) => (
                <div key={title}>
                  <p className="text-xs uppercase tracking-wide text-muted mb-1">{title}</p>
                  <ul className="flex flex-col gap-1">
                    {list.map((entry, i) => (
                      <li key={`${entry.path}-${i}`} className="flex items-start gap-2 text-sm">
                        <Badge tone={KIND_TONE[entry.kind]} className="shrink-0">
                          {entry.kind}
                        </Badge>
                        <span className="text-secondary">{entry.label}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </details>
        ) : (
          <p className="text-sm text-secondary whitespace-pre-wrap">{summarise(version)}</p>
        )}
      </div>
    </div>
  );
}

/**
 * Canon version history — published + archived rows, newest first.
 *
 * Changelogs are generated at publish time from the canon diff, so each row
 * expands into a real list of what changed, grouped by the subtab that owns it,
 * rather than whatever an admin remembered to type into a text box. Versions
 * published before migration 20260902 carry no structured entries and fall back
 * to their flat changelog text.
 */
export default function CanonHistory() {
  const { data: versions = [], isLoading, error } = useVersions();

  if (isLoading) return <p className="text-sm text-muted">Loading…</p>;
  if (error) return <Banner tone="danger">{(error as Error).message}</Banner>;

  if (versions.length === 0) {
    return (
      <Card>
        <p className="text-center text-faint text-sm py-6">No versions published yet</p>
      </Card>
    );
  }

  return (
    <Card padding="" className="overflow-hidden">
      {versions.map((version) => (
        <VersionRowItem key={version.id} version={version} />
      ))}
    </Card>
  );
}
