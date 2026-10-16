/**
 * The email a partner gets when the brewery counters their batch request with
 * a different share of the brew. Pure: the decide route owns sending it.
 */
import { env } from "@/lib/env";

export interface OfferEmailInput {
  company_name: string; beer_name: string; turns: number; brew_bbl: number;
  asked_bbl: number; asked_pct: number; offered_bbl: number; offered_pct: number; note: string;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const bbl = (n: number) => `${Number(n.toFixed(2))} bbl`;

export function renderOfferEmail(o: OfferEmailInput): { subject: string; html: string } {
  const url = `${env.appUrl()}/partner`;
  const turns = `${o.turns} turn${o.turns === 1 ? "" : "s"}`;
  const subject = `${o.beer_name}: we can offer ${o.offered_pct}% of the batch (about ${bbl(o.offered_bbl)})`;
  const html = `
    <p>Hi ${esc(o.company_name)},</p>
    <p>You asked for about <strong>${bbl(o.asked_bbl)}</strong> of <strong>${esc(o.beer_name)}</strong> from a ${turns} brew
    (roughly ${bbl(o.brew_bbl)}), which is ${o.asked_pct}% of the batch.</p>
    <p>We can offer <strong>${o.offered_pct}% of the batch — about ${bbl(o.offered_bbl)}</strong>.</p>
    <p style="white-space:pre-wrap;border-left:3px solid #ccc;padding-left:12px">${esc(o.note)}</p>
    <p>Nothing is booked yet. <a href="${url}">Open the partner portal</a> to accept this share or rescind the request.
    Barrel figures are brewhouse estimates; expect a little less after fermentation and packaging.</p>
  `.trim();
  return { subject, html };
}
