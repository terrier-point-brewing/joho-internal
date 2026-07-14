/**
 * Per-authority account/license/registration numbers (`tax_registrations`) —
 * a finer grain than `tax_authorities` (see lib/tax/authorities.ts): an
 * authority (NC DOR, IRS, ...) may hold N registrations (FEIN, permit #,
 * account #, ...). Rows are fully replaced from the settings UI on each
 * save: existing rows whose id is missing from the incoming payload are
 * deleted, the rest are upserted (rows without an id are new inserts).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface TaxRegistration {
  id: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
}

export interface TaxRegistrationInput {
  id?: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
}

/**
 * Pure reconciliation: which existing rows are no longer present in the
 * incoming payload (by id) and must be deleted. Rows in `incoming` without
 * an `id` are new inserts (not deletions); rows with an id present in
 * `incoming` are updates (kept).
 */
export function reconcileRegistrations(
  existingIds: string[],
  incoming: { id?: string }[],
): { deleteIds: string[] } {
  const incomingIds = new Set(incoming.map((row) => row.id).filter((id): id is string => Boolean(id)));
  const deleteIds = existingIds.filter((id) => !incomingIds.has(id));
  return { deleteIds };
}

export async function listRegistrations(sb: SupabaseClient): Promise<TaxRegistration[]> {
  const { data, error } = await sb
    .from("tax_registrations")
    .select("id, authority_key, label, number, display_order")
    .order("authority_key")
    .order("display_order");
  if (error) throw new Error(error.message);
  return (data as TaxRegistration[] | null) ?? [];
}

export async function saveRegistrations(sb: SupabaseClient, rows: TaxRegistrationInput[]): Promise<void> {
  const { data: existing, error: selectError } = await sb.from("tax_registrations").select("id");
  if (selectError) throw new Error(selectError.message);
  const existingIds = ((existing as { id: string }[] | null) ?? []).map((row) => row.id);

  const { deleteIds } = reconcileRegistrations(existingIds, rows);
  if (deleteIds.length > 0) {
    const { error: deleteError } = await sb.from("tax_registrations").delete().in("id", deleteIds);
    if (deleteError) throw new Error(deleteError.message);
  }

  const now = new Date().toISOString();
  const inserts = rows.filter((row) => !row.id).map((row) => ({ ...row, updated_at: now }));
  const upserts = rows.filter((row) => row.id).map((row) => ({ ...row, updated_at: now }));

  // PostgREST rejects a heterogeneous batch (mixing id-less and id-bearing
  // rows) in a single upsert — it sends id=NULL for the id-less rows, which
  // violates the NOT NULL PK and fails the whole batch. Split into a plain
  // insert (DB default fills id via gen_random_uuid()) and an upsert.
  if (inserts.length > 0) {
    const { error: insertError } = await sb.from("tax_registrations").insert(inserts);
    if (insertError) throw new Error(insertError.message);
  }

  if (upserts.length > 0) {
    const { error: upsertError } = await sb.from("tax_registrations").upsert(upserts, { onConflict: "id" });
    if (upsertError) throw new Error(upsertError.message);
  }
}
