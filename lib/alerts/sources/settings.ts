/**
 * Environment alerts: people waiting to be let in, scheduled jobs that have
 * stopped, and Square mappings pointing at nothing.
 */
import { CAP } from "@/lib/auth/capabilities";
import { CRON_JOBS } from "@/lib/cron/registry";
import { findDeadLinks } from "@/lib/square/linkHealth";
import type { AlertItem, AlertSource } from "../types";
import { agedSeverity, isoDate } from "./helpers";

// ── Access requests ──────────────────────────────────────────────────────────

export const accessRequests: AlertSource = {
  key: "access-requests",
  label: "Access requests",
  section: "settings",
  href: "/settings/environment/requests",
  requires: CAP.usersManage,
  async load(admin, { today }) {
    const { data, error } = await admin
      .from("account_requests")
      .select("id, name, email, reason, created_at")
      .eq("status", "pending")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    type Row = { id: string; name: string; email: string; reason: string | null; created_at: string };
    return ((data ?? []) as Row[]).map((r) => ({
      key: `access-request:${r.id}`,
      title: `${r.name} (${r.email}) asked for access`,
      detail: r.reason ? `"${r.reason}"` : "No reason given. Approve or deny the request.",
      href: "/settings/environment/requests",
      severity: agedSeverity(r.created_at, today, 3),
      when: isoDate(r.created_at),
    }));
  },
};

// ── Scheduled jobs that failed or went quiet ─────────────────────────────────
// The Cron Jobs monitor's overdue/failed states. A job that has never run is
// left out: a freshly shipped job is not a problem until its first run is late.

export const cronHealth: AlertSource = {
  key: "cron-health",
  label: "Scheduled jobs",
  section: "settings",
  href: "/settings/environment/cron",
  requires: CAP.cronRead,
  async load(admin) {
    const { data, error } = await admin
      .from("cron_runs")
      .select("job, status, started_at, error")
      .order("started_at", { ascending: false })
      .limit(400);
    if (error) throw new Error(error.message);
    type Run = { job: string; status: "success" | "error"; started_at: string; error: string | null };
    const latest = new Map<string, Run>();
    const lastSuccess = new Map<string, Run>();
    for (const r of (data ?? []) as Run[]) {
      if (!latest.has(r.job)) latest.set(r.job, r);
      if (r.status === "success" && !lastSuccess.has(r.job)) lastSuccess.set(r.job, r);
    }

    const items: AlertItem[] = [];
    const now = Date.now();
    for (const job of CRON_JOBS) {
      const last = latest.get(job.job);
      if (!last) continue;
      const ok = lastSuccess.get(job.job);
      const hoursSinceOk = ok ? (now - Date.parse(ok.started_at)) / 3_600_000 : Infinity;
      if (last.status === "error") {
        items.push({
          key: `cron-failed:${job.job}`,
          title: `${job.job} failed its last run`,
          detail: last.error ?? "See the run history for the error.",
          href: "/settings/environment/cron",
          severity: "danger",
          when: isoDate(last.started_at),
        });
      } else if (hoursSinceOk > job.maxAgeHours) {
        items.push({
          key: `cron-overdue:${job.job}`,
          title: `${job.job} has not succeeded in ${Math.round(hoursSinceOk / 24)} days`,
          detail: `Expected ${job.scheduleLabel.toLowerCase()}. Check the schedule and run it by hand if it is stuck.`,
          href: "/settings/environment/cron",
          severity: "danger",
          when: ok ? isoDate(ok.started_at) : null,
        });
      }
    }
    return items;
  },
};

// ── Square mappings pointing at nothing ──────────────────────────────────────

export const deadSquareLinks: AlertSource = {
  key: "dead-square-links",
  label: "Square mappings to fix",
  section: "settings",
  href: "/settings/catalog",
  requires: CAP.catalogRead,
  async load(admin) {
    const dead = await findDeadLinks(admin);
    return dead.map((d) => ({
      key: `dead-link:${d.linkId}`,
      title: `${d.itemName ?? "An item"}${d.variationName ? ` · ${d.variationName}` : ""} is mapped to a Square product that no longer exists`,
      detail: d.reason === "deleted_in_square"
        ? "The product was deleted in Square. Re-point the mapping or remove it, or its sales stop draining stock."
        : "The product is not in the Square catalogue mirror. Re-point the mapping or run the catalogue sync.",
      href: "/settings/catalog",
      severity: "info" as const,
    }));
  },
};

export const SETTINGS_SOURCES: AlertSource[] = [accessRequests, cronHealth, deadSquareLinks];
