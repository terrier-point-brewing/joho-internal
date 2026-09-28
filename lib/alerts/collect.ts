/**
 * Runs every alert source the caller may see and hands back the groups.
 *
 * Sources run in parallel and in isolation: one that throws becomes a group
 * carrying `error`, never a failed page or a missed email. The filter by
 * grants happens BEFORE the sources run, so a viewer who can see none of them
 * costs no queries at all, and so the digest can compute one full set for an
 * admin and narrow it per recipient without re-running anything.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { can, type ScopeGrants } from "@/lib/auth/resolve";
import type { AlertGroup, AlertItem, AlertSource, AlertSourceDefinition } from "./types";
import { SECTION_ORDER } from "./types";
import { ALERT_SOURCES } from "./sources";

export interface CollectOptions {
  /** Only sources the holder of these grants can open are run. */
  grants: ScopeGrants;
  today?: string;
  /** Test seam. Defaults to every registered source. */
  sources?: AlertSource[];
}

function mayOpen(grants: ScopeGrants, source: AlertSourceDefinition): boolean {
  return can(grants, source.requires.scope, source.requires.level);
}

export async function collectAlerts(admin: SupabaseClient, options: CollectOptions): Promise<AlertGroup[]> {
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const sources = (options.sources ?? ALERT_SOURCES).filter((s) => mayOpen(options.grants, s));

  const groups = await Promise.all(
    sources.map(async (source): Promise<AlertGroup> => {
      const base = {
        key: source.key,
        label: source.label,
        section: source.section,
        href: source.href,
        requires: source.requires,
      };
      try {
        const items = await source.load(admin, { today });
        return { ...base, items: sortItems(items) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[alerts] source failed", { source: source.key, error: message });
        return { ...base, items: [], error: message };
      }
    }),
  );

  return sortGroups(groups);
}

/** Narrow an already-collected set to what a different grant set may see. */
export function filterGroupsForGrants(groups: AlertGroup[], grants: ScopeGrants): AlertGroup[] {
  return groups.filter((g) => mayOpen(grants, g));
}

/** Danger before info; within a severity, the oldest date first, undated last. */
export function sortItems(items: AlertItem[]): AlertItem[] {
  return [...items].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "danger" ? -1 : 1;
    if (a.when && b.when) return a.when.localeCompare(b.when);
    if (a.when) return -1;
    if (b.when) return 1;
    return a.title.localeCompare(b.title);
  });
}

function sortGroups(groups: AlertGroup[]): AlertGroup[] {
  const order = new Map(SECTION_ORDER.map((s, i) => [s, i]));
  const registry = new Map((ALERT_SOURCES as AlertSourceDefinition[]).map((s, i) => [s.key, i]));
  return [...groups].sort((a, b) => {
    const s = (order.get(a.section) ?? 99) - (order.get(b.section) ?? 99);
    if (s !== 0) return s;
    return (registry.get(a.key) ?? 99) - (registry.get(b.key) ?? 99);
  });
}

/** Everything a person has to do, across every group they can see. */
export function countItems(groups: AlertGroup[]): { total: number; danger: number } {
  let total = 0;
  let danger = 0;
  for (const g of groups) {
    total += g.items.length;
    danger += g.items.filter((i) => i.severity === "danger").length;
  }
  return { total, danger };
}
