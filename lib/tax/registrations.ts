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
  /**
   * Which kind of registration this row holds, matching a
   * `RequiredRegistration.registrationKey`. `null` for freeform "Other" rows
   * the operator typed in, which no party template requires.
   */
  registration_kind: string | null;
}

export interface TaxRegistrationInput {
  id?: string;
  authority_key: string;
  label: string;
  number: string | null;
  display_order: number;
  registration_kind?: string | null;
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
    .select("id, authority_key, label, number, display_order, registration_kind")
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

  const inserts = rows.filter((row) => !row.id);
  const upserts = rows.filter((row) => row.id);

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

/**
 * A registration a party template needs on its worksheet header/settings —
 * resolved by (authority_key, key), never "first row for this authority".
 */
export interface RequiredRegistration {
  authorityKey: string;
  registrationKey: string;
  label: string;
  /**
   * A credential rather than a reference number (Wake County's 4-digit gross
   * receipts PIN is the one today). The stored value never reaches the browser
   * on the normal GET — `maskRegistrations` replaces it with
   * `"present"`/`"absent"`, exactly as `tax_filing_profiles` treats a
   * `sensitive` FieldSpec — and only the admin-only reveal route
   * (`/api/tax/registrations/reveal`) returns the real digits. Sensitivity is
   * a property of the KIND, so every party declaring the same
   * (authorityKey, registrationKey) inherits it.
   */
  sensitive?: boolean;
  /**
   * Sort position in the worksheet's "Registrations & Permits" group, shared
   * with any `settingsSchema` field that declares `identityGroup:
   * "registrations"` — one order space, so a party can interleave a filing
   * credential between two of its registrations. Unset sorts last (in
   * declaration order), which is how the universal FEIN row lands at the end.
   */
  identityOrder?: number;
}

/** A `RequiredRegistration` resolved against the live `tax_registrations` rows. */
export interface ResolvedRequiredRegistration extends RequiredRegistration {
  id?: string;
  number: string | null;
}

/** `"authorityKey:registrationKey"` — the identity a registration kind is matched by. */
export function registrationKindKey(authorityKey: string, registrationKey: string): string {
  return `${authorityKey}:${registrationKey}`;
}

/** The set of kinds any party template declares `sensitive`. */
export function sensitiveRegistrationKinds(requirements: RequiredRegistration[]): Set<string> {
  const kinds = new Set<string>();
  for (const req of requirements) {
    if (req.sensitive) kinds.add(registrationKindKey(req.authorityKey, req.registrationKey));
  }
  return kinds;
}

/**
 * Replaces the `number` of every registration whose kind is `sensitive` with
 * `"present"` / `"absent"` — the only status the browser is allowed to see for
 * a credential. Mirrors `maskSensitive` in lib/tax/profiles.ts. Non-sensitive
 * rows pass through untouched.
 */
export function maskRegistrations<T extends { authority_key: string; registration_kind: string | null; number: string | null }>(
  registrations: T[],
  sensitiveKinds: Set<string>,
): T[] {
  return registrations.map((row) => {
    if (!row.registration_kind) return row;
    if (!sensitiveKinds.has(registrationKindKey(row.authority_key, row.registration_kind))) return row;
    return { ...row, number: row.number && row.number.length > 0 ? "present" : "absent" };
  });
}

/** The resolved-requirement flavour of `maskRegistrations` (same rule, different shape). */
export function maskResolvedRegistrations(
  resolved: ResolvedRequiredRegistration[],
): ResolvedRequiredRegistration[] {
  return resolved.map((req) =>
    req.sensitive ? { ...req, number: req.number && req.number.length > 0 ? "present" : "absent" } : req,
  );
}

/**
 * Blank = "leave unchanged" for a sensitive registration, so the masked
 * round-trip (the UI never holds the real digits) can't wipe the stored value.
 * Applied to the incoming PUT payload before `saveRegistrations` replaces the
 * set. A row that is sensitive AND arrives blank keeps `existing`'s number; a
 * sensitive row with a real new value overwrites, same as any other row.
 */
export function preserveBlankSensitiveNumbers(
  incoming: TaxRegistrationInput[],
  existing: TaxRegistration[],
  sensitiveKinds: Set<string>,
): TaxRegistrationInput[] {
  const byId = new Map(existing.map((row) => [row.id, row]));
  return incoming.map((row) => {
    if (row.number && row.number.trim().length > 0) return row;
    if (!row.id || !row.registration_kind) return row;
    if (!sensitiveKinds.has(registrationKindKey(row.authority_key, row.registration_kind))) return row;
    const stored = byId.get(row.id);
    return stored ? { ...row, number: stored.number } : row;
  });
}

/** Universal requirement every party gets without declaring it itself. */
export const BASE_REQUIRED_REGISTRATIONS: RequiredRegistration[] = [
  { authorityKey: "irs", registrationKey: "fein", label: "Federal EIN (FEIN)" },
];

/**
 * Resolves a list of requirements (already merged from `BASE_REQUIRED_REGISTRATIONS`
 * + a party's own `requiredRegistrations`, or from several parties' combined
 * lists) against the live `tax_registrations` rows. Dedupes by
 * `authorityKey:registrationKey` (first occurrence's label wins) so callers
 * can pass overlapping lists without pre-filtering.
 */
export function resolveRequiredRegistrations(
  requirements: RequiredRegistration[],
  registrations: TaxRegistration[],
): ResolvedRequiredRegistration[] {
  const seen = new Set<string>();
  const deduped: RequiredRegistration[] = [];
  for (const req of requirements) {
    const dedupeKey = `${req.authorityKey}:${req.registrationKey}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    deduped.push(req);
  }

  return deduped.map((req) => {
    const match = registrations.find(
      (r) => r.authority_key === req.authorityKey && r.registration_kind === req.registrationKey,
    );
    return { ...req, id: match?.id, number: match?.number ?? null };
  });
}
