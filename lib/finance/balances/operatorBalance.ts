/**
 * Writing the figure an `operatorBalance` setup field asks for.
 *
 * ── It is an ordinary manual entry, not a private store ──────────────────────
 * One balance per account per month end is exactly what `manual_entries`
 * already holds, with the partial unique index, the Manual Entries screen and
 * the month-end close workflow attached to it. A second store for the same fact
 * would mean two places to look and two that can disagree.
 *
 * ── Why this is not just POST /api/finance/manual-entries ────────────────────
 * That route creates, and answers 409 when a balance already exists, because
 * the Transactions screen wants to know it is about to overwrite something. A
 * setup panel wants the opposite: re-entering this month's figure after
 * checking it again is the normal operation, not a conflict. So this is
 * set-or-replace, and it goes through the same validator and reconciler.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { validateManualEntry } from "@/lib/finance/manualEntries";
import { reconcileCloseTasks } from "./closeTasks";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export interface OperatorBalanceInput {
  coaId: string;
  /** Must be a month end; validateManualEntry enforces it. */
  asOfDate: string;
  amountCents: number;
  label?: string;
}

export type OperatorBalanceResult = { ok: true; replaced: boolean } | { ok: false; error: string };

export async function setOperatorBalance(
  supabase: AdminClient,
  input: OperatorBalanceInput,
  actorId: string,
): Promise<OperatorBalanceResult> {
  const validation = validateManualEntry({
    entryKind: "balance",
    chartOfAccountsId: input.coaId,
    asOfDate: input.asOfDate,
    amountCents: input.amountCents,
  } as never);
  if (!validation.ok) return { ok: false, error: validation.error };

  // Select-then-write rather than upsert: manual_entries' one-balance-per-
  // period guard is a PARTIAL unique index (`where entry_kind = 'balance'`),
  // and ON CONFLICT cannot infer a partial index without repeating its
  // predicate, which PostgREST has no way to express. An upsert here would fail
  // at runtime rather than at review.
  const { data: existing, error: findError } = await supabase
    .from("manual_entries")
    .select("id")
    .eq("entry_kind", "balance")
    .eq("chart_of_accounts_id", input.coaId)
    .eq("as_of_date", input.asOfDate)
    .maybeSingle();
  if (findError) throw new Error(findError.message);

  const { error } = existing
    ? await supabase
        .from("manual_entries")
        .update({ amount_cents: input.amountCents, updated_by: actorId })
        .eq("id", (existing as { id: string }).id)
    : await supabase.from("manual_entries").insert({
        entry_kind: "balance",
        chart_of_accounts_id: input.coaId,
        as_of_date: input.asOfDate,
        amount_cents: input.amountCents,
        label: input.label ?? "Balance entered at setup",
        mapping_source: "manual",
        created_by: actorId,
        updated_by: actorId,
      });
  if (error) throw new Error(error.message);

  // Clears the month-end close task immediately rather than at the next cron
  // run. Never let a reconciler failure fail the write: the balance is the
  // user's data, the task is derived bookkeeping the cron will catch anyway.
  await reconcileCloseTasks(supabase, input.asOfDate).catch(() => {});

  return { ok: true, replaced: Boolean(existing) };
}

/** The account's most recent operator-entered balance, for the setup panel's field state. */
export async function latestOperatorBalance(
  supabase: AdminClient,
  coaIds: string[],
): Promise<Map<string, { asOfDate: string; cents: number }>> {
  const out = new Map<string, { asOfDate: string; cents: number }>();
  if (coaIds.length === 0) return out;

  // Newest first, so the first row seen per account is its latest.
  const { data, error } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id, as_of_date, amount_cents")
    .eq("entry_kind", "balance")
    .in("chart_of_accounts_id", coaIds)
    .order("as_of_date", { ascending: false });
  if (error) throw new Error(error.message);

  for (const row of (data ?? []) as { chart_of_accounts_id: string; as_of_date: string; amount_cents: number }[]) {
    if (!out.has(row.chart_of_accounts_id)) {
      out.set(row.chart_of_accounts_id, { asOfDate: row.as_of_date, cents: row.amount_cents });
    }
  }
  return out;
}
