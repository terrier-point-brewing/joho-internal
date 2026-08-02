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

export const RELEASE_STATUS_TONE: Record<BrandRelease["status"], Tone> = {
  draft: "accent",
  released: "success",
  archived: "neutral",
};

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs text-secondary">{label}</span>
      {children}
    </label>
  );
}
