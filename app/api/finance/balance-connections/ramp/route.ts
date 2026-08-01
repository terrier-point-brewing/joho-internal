/**
 * GET /api/finance/balance-connections/ramp
 *   The Ramp treasury accounts available to connect, each marked with the
 *   connection already pointing at it (if any).
 *
 * This is Ramp's SETUP flow and nothing more. Creating the connection is the
 * shared PUT /api/finance/balance-connections, and attaching it to a GL account
 * is the picker on Settings > Balance Sheet Accounts -- neither is rebuilt here.
 * All this route adds is the one thing only Ramp can answer: which external
 * accounts exist, and what they are called.
 *
 * ── No credential is involved ────────────────────────────────────────────────
 * Ramp authenticates with an app-level client id and secret held in env, shared
 * with the P&L's expense sync and nine other consumers. Those are deliberately
 * NOT moved into integration_connections: an env var is not in the database,
 * not in backups and not reachable by SQL, and the credential path under the
 * P&L is settled. A Ramp connection row therefore carries an empty credentials
 * object and exists only to record WHICH treasury account maps to the GL
 * account, plus the health line Settings reads.
 *
 * Manage-level, not read-level: the only reason to list these is to choose one,
 * which is a configuration change. Matches the PUT on the parent route.
 */
import { NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listConnections } from "@/lib/finance/balances/connections";
import { getRampBankAccounts } from "@/lib/ramp";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    // listConnections cannot select the credentials column, so nothing secret
    // can reach the response even though Ramp stores none anyway.
    const [accounts, connections] = await Promise.all([
      getRampBankAccounts(),
      listConnections(createSupabaseAdminClient(), "ramp"),
    ]);

    const connectionByExternalId = new Map(
      connections.filter((c) => c.externalId).map((c) => [c.externalId as string, c]),
    );

    return NextResponse.json({
      accounts: accounts.map((a) => {
        const existing = connectionByExternalId.get(a.id);
        return {
          id: a.id,
          name: a.name,
          accountType: a.account_type,
          // Present when this Ramp account already has a connection row, so the
          // page offers "connected" rather than a second row that would trip
          // the (provider, external_id) unique index with a raw 23505.
          connection: existing ? { id: existing.id, label: existing.label, status: existing.status } : null,
        };
      }),
    });
  } catch (err) {
    return apiError(err);
  }
}
