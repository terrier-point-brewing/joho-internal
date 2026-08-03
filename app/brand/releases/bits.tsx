"use client";

// Small shared pieces of the Releases workbench.

import Badge from "@/app/components/ui/Badge";
import { type Tone } from "@/app/components/ui/tone";
import type { ComponentStatus } from "@/lib/brand/releases";
import type { BrandRelease } from "@/lib/brand/releases";

export const COMPONENT_STATUS_META: Record<ComponentStatus, { label: string; tone: Tone }> = {
  not_started: { label: "Not started", tone: "neutral" },
  in_progress: { label: "In progress", tone: "info" },
  done: { label: "Ready", tone: "success" },
};

export function StatusChip({ status }: { status: ComponentStatus }) {
  const meta = COMPONENT_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/**
 * How a release's status reads to a human. The stored values are the table's
 * check constraint (`draft` / `released` / `archived`) and stay that way; the
 * workbench calls the live state "Published". Rendering `release.status` raw
 * was the bug this replaces — it put a lowercase enum on screen.
 *
 * `draft` was toned `accent`, which is the brand accent and washes out on the
 * ops surface; `info` reads as an actual state.
 */
export const RELEASE_STATUS_META: Record<BrandRelease["status"], { label: string; tone: Tone }> = {
  draft: { label: "Draft", tone: "info" },
  released: { label: "Published", tone: "success" },
  archived: { label: "Archived", tone: "neutral" },
};

export function ReleaseStatusBadge({ status }: { status: BrandRelease["status"] }) {
  const meta = RELEASE_STATUS_META[status];
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-secondary">{label}</span>
      {children}
    </label>
  );
}
