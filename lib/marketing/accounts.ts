/**
 * Connected channel logins — the table that holds live publishing credentials.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 * **`credentials` is written here and read only by the worker. It never leaves
 * the server.** `marketing_connected_accounts` has RLS on, no policies at all,
 * and its anon/authenticated grants revoked, so a browser cannot reach it even
 * with a valid session — but that only closes the Data API. What is left is
 * this module, and the way it is kept shut is mechanical rather than careful:
 *
 *   * {@link ACCOUNT_SAFE_COLUMNS} is the ONLY column list any read in
 *     marketing selects from this table. `credentials` is not in it.
 *   * Every write that touches the column selects that same list back, so a
 *     returning row physically cannot carry it.
 *   * Nothing here logs a row, an account, or an error it did not write itself.
 *
 * The consequence worth stating plainly: grep the module for `credentials` and
 * every hit is a write. That is the invariant, and it is checkable in one
 * command rather than by reading carefully.
 *
 * ── Disconnect does not delete ──────────────────────────────────────────────
 * A disconnected account keeps its row. Deliveries reference it, and a delivery
 * that published through a login is a historical fact — the FK is `on delete
 * set null` precisely so unlinking cannot erase where a post went. So the row
 * stays, its status says `disconnected`, and its credentials are emptied.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { MarketingRequestError } from "./errors";
import type { ConnectedAccountInput } from "./plugins/types";

const ACCOUNTS = "marketing_connected_accounts";

/**
 * Every column of this table that may leave the server. `credentials` is
 * absent, and that absence is the security boundary — do not add it here to
 * "just check something", and do not select `*` from this table anywhere.
 */
export const ACCOUNT_SAFE_COLUMNS =
  "id, provider, channel, external_id, external_parent_id, handle, token_expires_at, scopes, status, last_error, last_verified_at, created_at, updated_at";

/** A connected account as anything outside this module is allowed to see it. */
export interface ConnectedAccountSummary {
  id: string;
  provider: string;
  channel: string;
  externalId: string | null;
  externalParentId: string | null;
  handle: string | null;
  tokenExpiresAt: string | null;
  scopes: string[];
  status: string;
  lastError: string | null;
  lastVerifiedAt: string | null;
}

function toSummary(row: Record<string, unknown>): ConnectedAccountSummary {
  return {
    id: String(row.id),
    provider: String(row.provider),
    channel: String(row.channel),
    externalId: (row.external_id as string | null) ?? null,
    externalParentId: (row.external_parent_id as string | null) ?? null,
    handle: (row.handle as string | null) ?? null,
    tokenExpiresAt: (row.token_expires_at as string | null) ?? null,
    scopes: (row.scopes as string[] | null) ?? [],
    status: String(row.status),
    lastError: (row.last_error as string | null) ?? null,
    lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
  };
}

/**
 * Every stored login, oldest first — what the Accounts screen and the settings
 * panel both draw.
 *
 * Disconnected rows are included on purpose. They are the history of a channel
 * that WAS connected, and a screen offering "Reconnect" has to be able to say
 * which login it means. The credential is not here, for the reason the header
 * gives: {@link ACCOUNT_SAFE_COLUMNS} is the only shape this table is ever read
 * in.
 */
export async function listConnectedAccounts(client: SupabaseClient): Promise<ConnectedAccountSummary[]> {
  const { data, error } = await client
    .from(ACCOUNTS)
    .select(ACCOUNT_SAFE_COLUMNS)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`could not load the channel logins: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map(toSummary);
}

/**
 * Store what a completed OAuth callback produced, replacing whatever was there
 * for that `(provider, channel)`.
 *
 * **Upsert, not insert.** There is one brand, so there is one Instagram — the
 * table carries a unique index on `(provider, channel)` saying exactly that.
 * Re-connecting an account that already exists is the ordinary case (a token
 * expired, someone reconnected), and it must move the existing row rather than
 * fail on the index or, worse, leave a second row that the worker might pick
 * the stale one of.
 *
 * Written as update-then-insert rather than PostgREST's `upsert` because the
 * update must NOT clobber `created_by` and `created_at` on a re-connect: who
 * first connected a channel is a fact about the past. Two people re-connecting
 * the same channel in the same instant would race here, and the unique index is
 * what catches it — the loser gets an error rather than a duplicate row, which
 * is the right end for a race nobody can be having on purpose.
 *
 * `status` is reset to `connected` and `last_error` cleared: a fresh credential
 * makes yesterday's failure stale, and an error sitting next to a working login
 * reads as a live problem.
 */
export async function upsertConnectedAccount(
  client: SupabaseClient,
  input: ConnectedAccountInput,
  options: { createdBy?: string | null; now?: Date } = {},
): Promise<ConnectedAccountSummary> {
  const now = options.now ?? new Date();
  const shared = {
    external_id: input.externalId,
    external_parent_id: input.externalParentId,
    handle: input.handle,
    // SECRET, and this is one of the two lines in marketing that writes it.
    credentials: input.credentials,
    token_expires_at: input.tokenExpiresAt,
    scopes: input.scopes,
    status: "connected",
    last_error: null,
    last_verified_at: now.toISOString(),
    // updated_at is public.update_updated_at()'s. Never set from app code.
  };

  const { data: updated, error: updateErr } = await client
    .from(ACCOUNTS)
    .update(shared)
    .eq("provider", input.provider)
    .eq("channel", input.channel)
    // Note the column list: the row that comes back cannot contain the secret
    // that was just written, because it was never selected.
    .select(ACCOUNT_SAFE_COLUMNS);
  if (updateErr) throw new Error(`could not store the channel login: ${updateErr.message}`);

  const updatedRows = (updated ?? []) as Record<string, unknown>[];
  if (updatedRows.length > 0) return toSummary(updatedRows[0]);

  const { data: inserted, error: insertErr } = await client
    .from(ACCOUNTS)
    .insert({
      provider: input.provider,
      channel: input.channel,
      created_by: options.createdBy ?? null,
      ...shared,
    })
    .select(ACCOUNT_SAFE_COLUMNS);
  if (insertErr) throw new Error(`could not store the channel login: ${insertErr.message}`);

  const insertedRow = ((inserted ?? []) as Record<string, unknown>[])[0];
  if (!insertedRow) throw new Error("could not store the channel login: the insert returned no row");
  return toSummary(insertedRow);
}

/**
 * Unlink one account: mark it disconnected and empty its credentials.
 *
 * The row survives (see the header). `credentials` goes to `{}` rather than
 * null because the column is `not null default '{}'`, and emptying it is the
 * point of the whole operation — a disconnected login that still holds a live
 * token is a credential nobody is watching any more.
 *
 * Idempotent: disconnecting an already-disconnected account is a no-op that
 * still answers with the row, because a person pressing the button twice has
 * not made a mistake worth an error.
 */
export async function disconnectAccount(client: SupabaseClient, id: string): Promise<ConnectedAccountSummary> {
  const { data, error } = await client
    .from(ACCOUNTS)
    .update({
      status: "disconnected",
      // The second — and last — line in marketing that writes this column.
      credentials: {},
      last_error: null,
    })
    .eq("id", id)
    .select(ACCOUNT_SAFE_COLUMNS);
  if (error) throw new Error(`could not disconnect the channel login: ${error.message}`);

  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) throw new MarketingRequestError("There is no connected account with that id.", 404);
  return toSummary(row);
}
