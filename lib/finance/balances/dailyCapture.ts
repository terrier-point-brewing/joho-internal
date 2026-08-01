/**
 * Daily balance capture for sources that cannot be asked about the past.
 *
 * Ramp can return a date range of historical balances, so it needs none of
 * this. Plaid cannot: `/accounts/balance/get` answers "what is it right now"
 * and takes no as-of date, and there is no historical balance endpoint at any
 * price tier. A month-end figure therefore exists only if something wrote it
 * down on the day. This is that something.
 *
 * ── Generic on purpose ───────────────────────────────────────────────────────
 * Built by the Plaid work stream, which is the first with a real consumer, but
 * deliberately parameterised by connection provider and by a reader function
 * rather than hard-wired to Plaid. Square's derived balance has the same
 * property -- an anchor plus movement can only be evaluated as of now -- so it
 * should register a second reader here rather than build a second cron. Nothing
 * in this module imports lib/plaid.
 *
 * ── What is recorded, and under which date ───────────────────────────────────
 * `asOfDate` is what the figure REPRESENTS, not the moment of the HTTP call.
 * The cron is scheduled so that "now" in the brewery's zone is late on the day
 * being recorded -- see app/api/cron/balance-capture/route.ts. A reading taken
 * in the small hours and filed against the previous month end would be a quiet
 * lie of exactly the kind the balance-sheet work exists to prevent.
 *
 * ── Failure is per connection ────────────────────────────────────────────────
 * One bank being unreachable must not cost every other account its capture for
 * the day, because a missed day is not recoverable later. Each connection is
 * isolated, and its outcome is written to the connection row so the Settings
 * status line shows it.
 */
import type { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { DeclaredSource } from "./snapshot";
import { fetchDeclaredSources } from "./snapshot";
import { getMethod, connectionProviderOf } from "./methods/registry";
import type { ConnectionProvider } from "./methods/registry";
import {
  getConnectionWithSecrets,
  recordDailyBalance,
  recordSyncResult,
  type ConnectionWithSecrets,
} from "./connections";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

/** One connection, and every GL account whose balance it feeds. */
export interface CaptureTarget {
  connectionId: string;
  coaIds: string[];
}

/**
 * Reads one connection's current balance in internal-convention cents, or null
 * when the source can give no figure at all (which is recorded as a failed read
 * rather than as a zero balance).
 *
 * Throwing is the right response to an outage or an expired credential; set
 * `needsReauth` on the thrown error to have the operator prompted to relink.
 */
export type BalanceReader = (connection: ConnectionWithSecrets) => Promise<number | null>;

export interface CaptureOutcome {
  /** Daily rows written. */
  captured: number;
  /** Connections whose read failed or produced no figure. */
  failed: number;
  /** Connections considered. */
  considered: number;
  errors: string[];
}

/**
 * Pure. Which connections must be read for `provider`, and which accounts each
 * one feeds.
 *
 * Driven off the same balance_sheet_account_sources rows the monthly snapshot
 * reads, so an account is captured exactly when it is configured to use an
 * integration method -- there is no second place to register an account for
 * capture and therefore no way for the two lists to disagree.
 *
 * A source naming a bare provider key rather than a method is ignored. Only a
 * METHOD declares a connection field, and every integration source is written
 * as a method by the Settings screen; the legacy bare-key rows that
 * expandSources still tolerates all predate integrations entirely.
 */
export function planCaptures(declared: DeclaredSource[], provider: ConnectionProvider): CaptureTarget[] {
  const byConnection = new Map<string, string[]>();

  for (const source of declared) {
    const method = getMethod(source.providerKey);
    if (!method || connectionProviderOf(method) !== provider) continue;

    const connectionId = source.config.connectionId;
    // Not yet linked to a connection. Nothing to read; the account already
    // reads as unsourced on the statement, which is the visible signal.
    if (typeof connectionId !== "string" || connectionId.length === 0) continue;

    const coaIds = byConnection.get(connectionId);
    if (coaIds) {
      if (!coaIds.includes(source.coaId)) coaIds.push(source.coaId);
    } else {
      byConnection.set(connectionId, [source.coaId]);
    }
  }

  return [...byConnection].map(([connectionId, coaIds]) => ({ connectionId, coaIds }));
}

/** True when the thrown value asked to be treated as an expired credential. */
function isReauth(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { needsReauth?: unknown }).needsReauth === true;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reads every connection of `provider` and records today's balance for the
 * accounts it feeds.
 *
 * Note the asymmetry in what is treated as a failure: a read that THROWS and a
 * read that returns null are both failures here, because on a bank account
 * "the balance is unknown" and "the balance is nothing" are different facts and
 * only one of them is safe to store. A null is never written as a zero.
 */
export async function captureDailyBalances(
  supabase: AdminClient,
  opts: { provider: ConnectionProvider; asOfDate: string; read: BalanceReader },
): Promise<CaptureOutcome> {
  const declared = await fetchDeclaredSources(supabase);
  const targets = planCaptures(declared, opts.provider);

  const outcome: CaptureOutcome = { captured: 0, failed: 0, considered: targets.length, errors: [] };

  for (const target of targets) {
    try {
      const connection = await getConnectionWithSecrets(supabase, target.connectionId);
      if (!connection) {
        // A source pointing at a deleted connection. Reported rather than
        // skipped silently, because the account will quietly stop being
        // captured and nothing else would say so.
        throw new Error(`connection ${target.connectionId} no longer exists`);
      }
      if (connection.status === "disabled") continue;

      const cents = await opts.read(connection);
      if (cents === null) throw new Error("the source returned no balance");

      for (const coaId of target.coaIds) {
        await recordDailyBalance(supabase, {
          coaId,
          asOfDate: opts.asOfDate,
          balanceCents: cents,
          connectionId: connection.id,
        });
        outcome.captured++;
      }

      await recordSyncResult(supabase, connection.id, { ok: true });
    } catch (err) {
      outcome.failed++;
      outcome.errors.push(`${opts.provider} connection ${target.connectionId}: ${message(err)}`);
      // Best-effort: if the connection row itself is unwritable there is
      // nothing further to do, and it must not take the remaining connections
      // down with it. Their day's capture is not recoverable tomorrow.
      try {
        await recordSyncResult(supabase, target.connectionId, {
          ok: false,
          error: message(err),
          needsReauth: isReauth(err),
        });
      } catch {
        // swallowed deliberately -- see above
      }
    }
  }

  return outcome;
}
