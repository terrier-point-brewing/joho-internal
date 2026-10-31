import type { Tone } from "@/app/components/ui/tone";
import { bbl, dollars, shortDate, type PortalHistory, type PortalRequest } from "./types";

export type AlertTab = "batches" | "requests" | "history";
export interface HomeAlert {
  key: string;
  tone: Tone;
  title: string;
  detail: string | null;
  /** Where the partner goes to deal with it. */
  tab: AlertTab;
  cta: string;
}

/** How long a refund or a declined request stays on the home screen. */
const REFUND_DAYS = 30;
const DECLINED_DAYS = 14;

const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86_400_000);

/**
 * What needs the partner's attention, most urgent first. Every row is derived
 * from data the portal already holds: there is no alert table, nothing to mark
 * read, and a row leaves the list by the thing being dealt with. An empty
 * list means nothing is waiting on them.
 */
export function homeAlerts(history: PortalHistory | undefined, requests: PortalRequest[], today: string): HomeAlert[] {
  const out: HomeAlert[] = [];

  // 1. Money past due.
  if (history && history.summary.overdue_cents > 0) {
    const n = history.open_invoices.filter((i) => i.overdue).length;
    const oldest = Math.max(0, ...history.open_invoices.map((i) => i.days_overdue));
    out.push({
      key: "overdue", tone: "danger",
      title: `${dollars(history.summary.overdue_cents)} is overdue`,
      detail: `${n} invoice${n === 1 ? "" : "s"} past due, the oldest by ${oldest} day${oldest === 1 ? "" : "s"}.`,
      tab: "history", cta: "Pay now",
    });
  }

  // 2. A counter-offer waiting on their answer.
  for (const r of requests.filter((r) => r.status === "adjusted" && r.offer)) {
    out.push({
      key: `offer:${r.id}`, tone: "accent",
      title: `We offered ${r.offer!.pct}% of the ${r.beer_name} batch`,
      detail: `About ${bbl(r.offer!.bbl)}. The request is on hold until you accept or decline.`,
      tab: "requests", cta: "Answer",
    });
  }

  // 3. A deposit unpaid on a deal that has a brew behind it. Only a paid
  //    deposit commits anyone to anything, so this is the one that costs them.
  for (const d of history?.deals.filter((d) => d.status === "open" && d.has_batch && d.deposit?.status === "unpaid") ?? []) {
    const dep = d.deposit!;
    const owed = Math.max(0, dep.billed_cents - dep.paid_cents);
    out.push({
      key: `deposit:${d.id}`, tone: "danger",
      title: `Deposit for ${d.beer_name ?? "your batch"} is unpaid`,
      detail: `${dollars(owed)} still to pay${d.progress.brew_date ? ` · brew date ${shortDate(d.progress.brew_date)}` : ""}.`,
      tab: "batches", cta: "See the invoice",
    });
  }

  // 4. Beer packaged and waiting for them to call it in. One row however
  //    many beers, so a busy partner's refunds are not pushed off the list.
  const ready = history?.deals.filter((d) => d.status === "open" && d.progress.step === 5 && d.expected_bbl - d.shipped_bbl > 0.005) ?? [];
  if (ready.length > 0) {
    const total = Math.round(ready.reduce((s, d) => s + d.expected_bbl - d.shipped_bbl, 0) * 100) / 100;
    out.push({
      key: "ready", tone: "success",
      title: ready.length === 1
        ? `${bbl(total)} of ${ready[0].beer_name ?? "beer"} is packaged and ready`
        : `${bbl(total)} across ${ready.length} beers is packaged and ready`,
      detail: ready.length === 1 ? "On our floor now. Tell us when you want it." : `${ready.map((d) => d.beer_name ?? "beer").join(", ")}. On our floor now. Tell us when you want it.`,
      tab: "batches", cta: "See my batches",
    });
  }

  // 5. Money on its way back, or recently landed.
  for (const r of history?.refunds.filter((r) => r.status === "processing" || (r.date && daysBetween(r.date, today) <= REFUND_DAYS)) ?? []) {
    out.push({
      key: `refund:${r.id}`, tone: "info",
      title: r.status === "processing" ? `${dollars(r.amount_cents)} refund is processing` : `${dollars(r.amount_cents)} was refunded to you${r.date ? ` ${shortDate(r.date)}` : ""}`,
      detail: [r.reason, r.invoice ? `invoice ${r.invoice.number ?? ""}`.trim() : null].filter(Boolean).join(" · ") || null,
      tab: "history", cta: "See refunds",
    });
  }

  // 6. A request we turned down recently, with our note.
  for (const r of requests.filter((r) => r.status === "declined" && r.decided_at && daysBetween(r.decided_at, today) <= DECLINED_DAYS)) {
    out.push({
      key: `declined:${r.id}`, tone: "neutral",
      title: `Your ${r.beer_name} request was declined`,
      detail: r.decision_note ?? null,
      tab: "requests", cta: "See request",
    });
  }

  return out;
}
