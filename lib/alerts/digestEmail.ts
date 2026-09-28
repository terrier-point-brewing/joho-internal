/**
 * Pure renderer for the daily alert digest. No DB or network access — the
 * alert-digest cron owns collecting the groups and calling sendEmail.
 *
 * One email per person, holding only the groups they can open. Empty groups
 * are left out: the email is a to-do list, not a status report, and a list of
 * "nothing here" lines buries the two things that matter.
 */
import { env, APP_URL_FALLBACK } from "@/lib/env";
import type { AlertGroup, AlertSection } from "./types";
import { SECTION_LABEL, SECTION_ORDER } from "./types";
import { countItems } from "./collect";

export interface RenderedDigestEmail {
  subject: string;
  html: string;
}

/** How many items a group lists before it says "and N more". */
const MAX_ITEMS_PER_GROUP = 8;

function escape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function longDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });
}

export function renderAlertDigestEmail(groups: AlertGroup[], today: string): RenderedDigestEmail {
  const base = env.appUrl();
  const linked = base !== APP_URL_FALLBACK;
  const withItems = groups.filter((g) => g.items.length > 0);
  const failed = groups.filter((g) => g.error);
  const { total, danger } = countItems(withItems);

  const subject = `TPB alerts — ${total} item${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} attention${danger > 0 ? ` (${danger} urgent)` : ""}`;

  const sections = SECTION_ORDER
    .filter((s) => withItems.some((g) => g.section === s))
    .map((section) => renderSection(section, withItems.filter((g) => g.section === section), base, linked))
    .join("");

  const failures = failed.length
    ? `<p style="color:#7f1d1d;font-size:13px">Could not check: ${failed.map((g) => escape(g.label)).join(", ")}. The Home page will say why.</p>`
    : "";

  const home = linked
    ? `<p><a href="${base}/home">Open the alert center</a></p>`
    : `<p>Open the app and press <strong>TPB</strong> at the top of the sidebar to see the alert center. (A direct link could not be included: this app's public web address has not been configured.)</p>`;

  const html = `
    <div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#18181b;max-width:640px">
      <p style="color:#71717a;margin:0 0 4px">${escape(longDate(today))}</p>
      <h1 style="font-size:18px;margin:0 0 16px">${total} thing${total === 1 ? "" : "s"} need${total === 1 ? "s" : ""} your attention${danger > 0 ? `, <span style="color:#b91c1c">${danger} urgent</span>` : ""}</h1>
      ${sections}
      ${failures}
      ${home}
      <p style="color:#a1a1aa;font-size:12px;margin-top:24px">You get this every morning because alert emails are switched on for your account. An admin can turn them off under Settings &rarr; Environment &rarr; Users.</p>
    </div>
  `.trim();

  return { subject, html };
}

function renderSection(section: AlertSection, groups: AlertGroup[], base: string, linked: boolean): string {
  const blocks = groups.map((g) => {
    const shown = g.items.slice(0, MAX_ITEMS_PER_GROUP);
    const rest = g.items.length - shown.length;
    const rows = shown.map((i) => {
      const dot = i.severity === "danger" ? "&#9679;" : "&#9675;";
      const title = linked ? `<a href="${base}${i.href}" style="color:#18181b">${escape(i.title)}</a>` : escape(i.title);
      const detail = i.detail ? `<div style="color:#71717a;font-size:12px">${escape(i.detail)}</div>` : "";
      return `<li style="margin:0 0 8px"><span style="color:${i.severity === "danger" ? "#b91c1c" : "#a1a1aa"}">${dot}</span> ${title}${detail}</li>`;
    }).join("");
    const more = rest > 0 ? `<li style="color:#71717a;font-size:12px;list-style:none">and ${rest} more</li>` : "";
    const heading = linked ? `<a href="${base}${g.href}" style="color:#18181b;text-decoration:none">${escape(g.label)}</a>` : escape(g.label);
    return `
      <h3 style="font-size:14px;margin:12px 0 6px">${heading} <span style="color:#71717a;font-weight:normal">(${g.items.length})</span></h3>
      <ul style="margin:0;padding-left:18px">${rows}${more}</ul>`;
  }).join("");

  return `
    <h2 style="font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:#a1a1aa;margin:20px 0 0">${SECTION_LABEL[section]}</h2>
    ${blocks}`;
}
