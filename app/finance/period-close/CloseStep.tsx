// One numbered step of the month-end close.
//
// Every step has the same four parts in the same place — its number, what it
// is, where it stands, and one or two sentences on how to do it — so the page
// reads top to bottom as a list of things to do rather than as a set of
// differently-shaped notices the reader has to work out are related.

import { type ReactNode } from "react";
import Badge from "@/app/components/ui/Badge";
import type { Tone } from "@/app/components/ui/tone";
import type { CloseStepStatus } from "../closeTasks";

const STATUS: Record<CloseStepStatus, { label: string; tone: Tone }> = {
  done: { label: "Done", tone: "success" },
  todo: { label: "To do", tone: "accent" },
  attention: { label: "Needs attention", tone: "danger" },
  // Something to read and judge, not something the page can tick off.
  review: { label: "For your review", tone: "neutral" },
};

export default function CloseStep({
  n,
  title,
  status,
  statusLabel,
  how,
  children,
}: {
  n: number;
  title: string;
  status: CloseStepStatus;
  /** Replaces the status's default wording, e.g. "Closed" on the last step. */
  statusLabel?: string;
  /** How to do this step, in a sentence or two. */
  how: ReactNode;
  children?: ReactNode;
}) {
  const s = STATUS[status];
  return (
    <section className="py-4 border-t border-line/40 first:border-t-0 first:pt-0 flex flex-col gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-faint font-mono tabular-nums">{n}.</span>
        <h3 className="text-sm text-strong">{title}</h3>
        <Badge tone={s.tone}>{statusLabel ?? s.label}</Badge>
      </div>
      <p className="text-xs text-secondary max-w-prose">{how}</p>
      {children}
    </section>
  );
}
