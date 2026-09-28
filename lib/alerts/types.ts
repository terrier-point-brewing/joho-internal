/**
 * The alert center's vocabulary, shared by the Home dashboard, the daily
 * digest email and every source that feeds them.
 *
 * An alert is one thing a person has to do, with a link to where they do it.
 * A group is one kind of alert — "Shipments to reconcile" — with the
 * capability its own screen gates on, so that what a person sees on Home is
 * exactly what they can act on, and the digest never tells anyone about work
 * they cannot open.
 *
 * Nothing here is persisted. Every source re-derives its items from the tables
 * the existing screens already read, so there is no second copy of "needs
 * attention" to fall out of step with the screen that resolves it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Capability } from "@/lib/auth/capabilities";

/**
 * `danger` — overdue, blocking, or money at risk. `info` — needs a decision or
 * an action, but nothing is late yet.
 */
export type AlertSeverity = "danger" | "info";

export type AlertSection = "production" | "finance" | "settings";

export interface AlertItem {
  /** Stable within a run; used as the React key and to dedupe in tests. */
  key: string;
  title: string;
  detail?: string;
  /** App-relative path that opens the thing to act on. */
  href: string;
  severity: AlertSeverity;
  /** ISO date the item is about (due date, occurred-at), for ordering and display. */
  when?: string | null;
}

export interface AlertGroup {
  key: string;
  label: string;
  section: AlertSection;
  /** Where the whole list is worked from. */
  href: string;
  /** The capability the group's own screen gates on. */
  requires: Capability;
  items: AlertItem[];
  /**
   * Set when the source threw. The group is still returned so the dashboard
   * can say "could not check" instead of silently showing all clear — a source
   * that fails quietly is worse than one that reports nothing.
   */
  error?: string;
}

/** What one source contributes: the group's shape and how to fill it. */
export interface AlertSourceDefinition {
  key: string;
  label: string;
  section: AlertSection;
  href: string;
  requires: Capability;
}

export interface AlertContext {
  /** Today in the brewery's calendar, YYYY-MM-DD. */
  today: string;
}

export interface AlertSource extends AlertSourceDefinition {
  load: (admin: SupabaseClient, ctx: AlertContext) => Promise<AlertItem[]>;
}

export const SECTION_LABEL: Record<AlertSection, string> = {
  production: "Production",
  finance: "Finance",
  settings: "Settings",
};

export const SECTION_ORDER: AlertSection[] = ["production", "finance", "settings"];
