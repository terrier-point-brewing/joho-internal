/**
 * The morning alert digest: one email per person who has switched alert
 * emails on, holding exactly the alerts they could open on the Home page.
 *
 * The alerts are collected ONCE, with every source running, and then narrowed
 * per recipient by their own grants — so a brewer's email lists the batches
 * and shipments and never the tax filings, and adding a recipient costs no
 * extra queries. A recipient with nothing to act on gets no email; an empty
 * digest is noise, and silence on a quiet day is the point of opting in.
 *
 * Nothing is marked as sent. The digest is a snapshot of what is open this
 * morning, so the same item appears every day until somebody deals with it —
 * which is what "in a timely manner" asks for. The per-item "alerted once"
 * rule stays with the jobs that own it (tax-tasks, balance-close); this job
 * never touches their columns.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { collectAlerts, countItems, filterGroupsForGrants } from "@/lib/alerts/collect";
import { renderAlertDigestEmail } from "@/lib/alerts/digestEmail";
import type { ScopeGrants } from "@/lib/auth/resolve";
import { getRoleBundle } from "@/lib/auth/roleBundles.server";
import type { UserRole } from "@/lib/auth/roleGrants";
import { ROOT } from "@/lib/auth/scopes";
import { sendEmail } from "@/lib/resend";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";
import { todayLocalDate } from "@/lib/utils/datetime";

interface Recipient {
  id: string;
  email: string;
  role: UserRole;
}

/** The grants a recipient holds, resolved the same way getSessionUser does it. */
async function grantsFor(admin: SupabaseClient, r: Recipient): Promise<ScopeGrants> {
  if (r.role !== "custom") return getRoleBundle(r.role);
  const { data, error } = await admin.from("user_permission_grants").select("scope, level").eq("user_id", r.id);
  if (error) throw new Error(error.message);
  return Object.fromEntries(((data ?? []) as { scope: string; level: string }[]).map((g) => [g.scope, g.level])) as ScopeGrants;
}

export async function runAlertDigest(admin: SupabaseClient) {
  const today = todayLocalDate(await getBreweryTimezone());

  const { data, error } = await admin
    .from("profiles")
    .select("id, email, role")
    .eq("alert_emails_enabled", true)
    .neq("role", "partner")
    .order("email");
  if (error) throw new Error(error.message);
  const recipients = (data ?? []) as Recipient[];

  // Nobody opted in: do not run a dozen queries to throw the answer away.
  if (recipients.length === 0) return { recipients: 0, sent: 0, skippedEmpty: 0, failed: 0, alerts: 0, today };

  // Every source, once. ROOT at admin is what an admin holds, so this is the
  // superset every recipient's view is cut from.
  const everything = await collectAlerts(admin, { grants: { [ROOT]: "admin" }, today });
  const { total: alerts } = countItems(everything);

  let sent = 0;
  let skippedEmpty = 0;
  let failed = 0;
  const errors: string[] = [];
  for (const r of recipients) {
    try {
      const mine = filterGroupsForGrants(everything, await grantsFor(admin, r));
      const { total } = countItems(mine);
      if (total === 0) { skippedEmpty++; continue; }
      const { subject, html } = renderAlertDigestEmail(mine, today);
      await sendEmail(r.email, subject, html);
      sent++;
    } catch (err) {
      // One bad address or one Resend hiccup must not cost everyone else
      // their morning email.
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`${r.email}: ${message}`);
      console.error("[alert-digest] could not send", { recipient: r.email, err });
    }
  }

  return {
    today,
    recipients: recipients.length,
    sent,
    skippedEmpty,
    failed,
    alerts,
    sourcesFailed: everything.filter((g) => g.error).map((g) => g.key),
    ...(errors.length ? { errors } : {}),
  };
}
