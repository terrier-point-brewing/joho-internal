/**
 * Shared plumbing for integration-backed balance methods.
 *
 * Every integration (Ramp, Plaid, Square) needs the same four things: somewhere
 * to keep what it is connected to, somewhere to keep a per-connection secret, a
 * place to record daily balances for dates that cannot be re-queried later, and
 * a way to tell the Settings screen whether it is healthy. Built once here so
 * three separate work streams do not each invent their own.
 *
 * Backed by 20260913090000_balance_integration_connections.sql.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { ConnectionStatus, ConnectionProvider } from "./methods/registry";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

export type { ConnectionProvider };
export type ConnectionState = "active" | "needs_reauth" | "disabled" | "error";

/**
 * A connection as anything outside this module may see it.
 *
 * `credentials` is deliberately absent from this type, not merely omitted from
 * a query. The Settings route serialises whatever it is handed, so the safe
 * shape has to be the DEFAULT one and the secret-bearing shape has to be the
 * thing you go out of your way to ask for.
 */
export interface IntegrationConnection {
  id: string;
  provider: ConnectionProvider;
  label: string;
  externalId: string | null;
  config: Record<string, unknown>;
  status: ConnectionState;
  lastSyncedAt: string | null;
  lastError: string | null;
}

/** A connection plus its secret. Only balance providers should ask for this. */
export interface ConnectionWithSecrets extends IntegrationConnection {
  credentials: Record<string, unknown>;
}

const SAFE_COLUMNS = "id, provider, label, external_id, config, status, last_synced_at, last_error";

interface ConnectionRow {
  id: string;
  provider: string;
  label: string;
  external_id: string | null;
  config: Record<string, unknown> | null;
  status: string;
  last_synced_at: string | null;
  last_error: string | null;
  credentials?: Record<string, unknown> | null;
}

function toConnection(row: ConnectionRow): IntegrationConnection {
  return {
    id: row.id,
    provider: row.provider as ConnectionProvider,
    label: row.label,
    externalId: row.external_id,
    config: row.config ?? {},
    status: row.status as ConnectionState,
    lastSyncedAt: row.last_synced_at,
    lastError: row.last_error,
  };
}

/** Every connection, without secrets. Safe to serialise to an authorised client. */
export async function listConnections(
  supabase: AdminClient,
  provider?: ConnectionProvider,
): Promise<IntegrationConnection[]> {
  let query = supabase.from("integration_connections").select(SAFE_COLUMNS).order("label");
  if (provider) query = query.eq("provider", provider);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return ((data ?? []) as ConnectionRow[]).map(toConnection);
}

/** One connection, without secrets. */
export async function getConnection(supabase: AdminClient, id: string): Promise<IntegrationConnection | null> {
  const { data, error } = await supabase
    .from("integration_connections")
    .select(SAFE_COLUMNS)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data ? toConnection(data as ConnectionRow) : null;
}

/**
 * One connection INCLUDING its credential. Call this only from a balance
 * provider's compute(), and never let the result reach a response body.
 */
export async function getConnectionWithSecrets(
  supabase: AdminClient,
  id: string,
): Promise<ConnectionWithSecrets | null> {
  const { data, error } = await supabase
    .from("integration_connections")
    .select(`${SAFE_COLUMNS}, credentials`)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const row = data as ConnectionRow;
  return { ...toConnection(row), credentials: row.credentials ?? {} };
}

/**
 * Resolves the connection a balance source is configured against.
 *
 * A source declares `{ connectionId }` in its config (the jsonb column on
 * balance_sheet_account_sources). Returns null when unset or dangling, which a
 * provider must translate into a null balance rather than an exception -- an
 * unconfigured account should read as unsourced, not blow up the statement.
 */
export async function resolveConnection(
  supabase: AdminClient,
  config: Record<string, unknown>,
): Promise<ConnectionWithSecrets | null> {
  const id = config.connectionId;
  if (typeof id !== "string" || id.length === 0) return null;
  return getConnectionWithSecrets(supabase, id);
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface ConnectionInput {
  /** Omit to create; supply to update in place. */
  id?: string;
  provider: ConnectionProvider;
  label: string;
  externalId?: string | null;
  config?: Record<string, unknown>;
  status?: ConnectionState;
}

/**
 * Creates or updates a connection's NON-SECRET fields and returns the safe
 * shape.
 *
 * `credentials` is deliberately not accepted. A secret must never arrive over a
 * request body: Plaid's token is produced by exchanging a public token
 * server-side, which is that integration's own job, and routing it through a
 * generic endpoint would put a live bank credential in a request log. Use
 * `writeCredentials` from server-side integration code instead.
 */
export async function upsertConnection(
  supabase: AdminClient,
  input: ConnectionInput,
  actorId?: string,
): Promise<IntegrationConnection> {
  const row: Record<string, unknown> = {
    provider: input.provider,
    label: input.label,
    external_id: input.externalId ?? null,
    config: input.config ?? {},
    updated_by: actorId ?? null,
  };
  if (input.status) row.status = input.status;

  const query = input.id
    ? supabase.from("integration_connections").update(row).eq("id", input.id)
    : supabase.from("integration_connections").insert({ ...row, created_by: actorId ?? null });

  const { data, error } = await query.select(SAFE_COLUMNS).single();
  if (error) throw new Error(error.message);
  return toConnection(data as ConnectionRow);
}

/**
 * Stores a secret. Server-side integration code only -- there is deliberately
 * no route that reaches this.
 */
export async function writeCredentials(
  supabase: AdminClient,
  id: string,
  credentials: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase
    .from("integration_connections")
    .update({ credentials, status: "active", last_error: null })
    .eq("id", id);
  if (error) throw new Error(error.message);
}

/**
 * Removes a connection.
 *
 * `gl_account_daily_balances.connection_id` is ON DELETE SET NULL, so captured
 * history survives and simply stops being attributed to a live feed. Any
 * balance source still naming this id resolves to null and reads as unsourced,
 * which is the correct visible outcome rather than a silent stale figure.
 */
export async function deleteConnection(supabase: AdminClient, id: string): Promise<void> {
  const { error } = await supabase.from("integration_connections").delete().eq("id", id);
  if (error) throw new Error(error.message);
}

/** Records the outcome of a read, driving the Settings status line. */
export async function recordSyncResult(
  supabase: AdminClient,
  id: string,
  outcome: { ok: true } | { ok: false; error: string; needsReauth?: boolean },
): Promise<void> {
  const patch = outcome.ok
    ? { status: "active", last_synced_at: new Date().toISOString(), last_error: null }
    : { status: outcome.needsReauth ? "needs_reauth" : "error", last_error: outcome.error.slice(0, 500) };

  const { error } = await supabase.from("integration_connections").update(patch).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Renders a connection for the Settings row. Pure. */
export function describeConnection(connection: IntegrationConnection | null): ConnectionStatus {
  if (!connection) {
    return { connected: false, label: "Not connected", remedy: "Choose an account for this integration." };
  }
  if (connection.status === "needs_reauth") {
    return {
      connected: false,
      label: connection.label,
      lastSyncedAt: connection.lastSyncedAt,
      remedy: "The connection expired. Reconnect to resume automatic balances.",
    };
  }
  if (connection.status === "disabled") {
    return { connected: false, label: connection.label, lastSyncedAt: connection.lastSyncedAt, remedy: "Turned off." };
  }
  if (connection.status === "error") {
    return {
      connected: false,
      label: connection.label,
      lastSyncedAt: connection.lastSyncedAt,
      remedy: connection.lastError ?? "The last read failed. It will retry on the next run.",
    };
  }
  return { connected: true, label: connection.label, lastSyncedAt: connection.lastSyncedAt };
}

// ── Daily balance capture ────────────────────────────────────────────────────

/**
 * Reads the balance captured for an exact date.
 *
 * Exact-date only, deliberately. Falling back to "the most recent capture
 * before this date" would silently present a 12-day-old bank balance as a
 * month-end figure -- plausible, undetectable, and wrong. A missing capture
 * must surface as a missing balance so the close workflow raises it.
 */
export async function readDailyBalance(
  supabase: AdminClient,
  coaId: string,
  asOfDate: string,
): Promise<number | null> {
  const { data, error } = await supabase
    .from("gl_account_daily_balances")
    .select("balance_cents")
    .eq("chart_of_accounts_id", coaId)
    .eq("as_of_date", asOfDate)
    .maybeSingle();
  if (error) return null;
  return data ? (data as { balance_cents: number }).balance_cents : null;
}

/**
 * Records the balance for a date, overwriting any existing capture for it.
 *
 * `asOfDate` is what the figure REPRESENTS, which is not always the day it was
 * fetched. Ramp returns dated history, so the two match. A real-time read (as
 * Plaid's is) taken on the 1st is an intraday balance for the 1st -- recording
 * it under the previous month end would be a quiet lie of exactly the kind this
 * whole feature exists to prevent. Record it under the date it belongs to and
 * let the month-end lookup miss if nothing captured that day.
 */
export async function recordDailyBalance(
  supabase: AdminClient,
  entry: { coaId: string; asOfDate: string; balanceCents: number; connectionId?: string | null },
): Promise<void> {
  const { error } = await supabase.from("gl_account_daily_balances").upsert(
    {
      chart_of_accounts_id: entry.coaId,
      as_of_date: entry.asOfDate,
      balance_cents: entry.balanceCents,
      connection_id: entry.connectionId ?? null,
      captured_at: new Date().toISOString(),
    },
    { onConflict: "chart_of_accounts_id,as_of_date" },
  );
  if (error) throw new Error(error.message);
}
