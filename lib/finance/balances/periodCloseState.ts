/**
 * Reading whether a period has been closed, and by whom.
 *
 * ── Why this is not simply part of periodClose.ts ────────────────────────────
 * Two modules need the answer and one of them is underneath the other.
 * `periodClose.ts` runs a snapshot as part of closing, so it imports
 * `snapshot.ts`; `snapshot.ts` has to refuse to recompute a closed month, so it
 * needs this. Keeping the read here is what stops that being a cycle. The write
 * side, the blockers and the coverage summary all stay in periodClose.ts, and
 * it re-exports these so callers still have one place to import from.
 *
 * ── Degrading when the table is not there yet ────────────────────────────────
 * Migrations in this repo are authored and applied separately, so this code
 * runs for a while against a database with no `balance_period_closes` table. A
 * missing table answers "no period has been closed", which is both true and the
 * pre-existing behaviour: nothing freezes, everything recomputes. §4 of the
 * handoff is explicit that a missing table must leave the balance sheet
 * rendering rather than throw.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type PeriodCloseAction = "closed" | "reopened";

/** Where a period currently stands, read off its most recent close event. */
export interface PeriodCloseState {
  periodEnd: string;
  /** True when the most recent event was a close. */
  closed: boolean;
  action: PeriodCloseAction;
  /** When that event happened -- `closed_at` when `closed` is true. */
  at: string;
  /** Who did it -- `closed_by` when `closed` is true. Null if their login has since gone. */
  actorId: string | null;
  actorEmail: string | null;
  /** Always present on a reopen; usually null on a close. */
  reason: string | null;
}

export interface CloseEventRow {
  period_end: string;
  action: PeriodCloseAction;
  actor_id: string | null;
  reason: string | null;
  created_at: string;
}

/** Postgres "relation does not exist", as PostgREST reports it before the migration is applied. */
function isMissingTable(error: { code?: string; message?: string }): boolean {
  return error.code === "42P01" || error.code === "PGRST205" || /balance_period_closes/.test(error.message ?? "");
}

/**
 * The period's current state, or null if it has never been closed or reopened.
 *
 * Null and "reopened" are different facts and both read as not-closed: the
 * first is a month nobody has ever finished, the second is one somebody
 * deliberately took back. The close panel says which.
 */
export async function readPeriodClose(supabase: AdminClient, periodEnd: string): Promise<PeriodCloseState | null> {
  const { data, error } = await supabase
    .from("balance_period_closes")
    .select("period_end, action, actor_id, reason, created_at")
    .eq("period_end", periodEnd)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    if (isMissingTable(error)) return null;
    throw new Error(error.message);
  }

  const row = ((data ?? []) as CloseEventRow[])[0];
  return row ? toState(supabase, row) : null;
}

export async function toState(supabase: AdminClient, row: CloseEventRow): Promise<PeriodCloseState> {
  return {
    periodEnd: row.period_end,
    closed: row.action === "closed",
    action: row.action,
    at: row.created_at,
    actorId: row.actor_id,
    actorEmail: row.actor_id ? await lookupEmail(supabase, row.actor_id) : null,
    reason: row.reason,
  };
}

/** One profile email, or null when the account has since been removed. */
async function lookupEmail(supabase: AdminClient, userId: string): Promise<string | null> {
  const { data, error } = await supabase.from("profiles").select("email").eq("id", userId).maybeSingle();
  if (error) return null;
  return (data as { email: string | null } | null)?.email ?? null;
}
