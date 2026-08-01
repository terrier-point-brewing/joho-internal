/**
 * Ramp's setup: list the treasury accounts, pick one.
 *
 * The simplest of the three, and the reason `discover` exists as a flow. Ramp
 * authenticates with app-level credentials that already serve the expense sync
 * under the P&L, so there is nothing for an operator to sign in to and no
 * per-connection secret. A Ramp connection row records WHICH treasury account
 * maps to the GL account, and nothing else.
 *
 * Moved here verbatim from app/api/finance/balance-connections/ramp/, which is
 * now served by the generic [provider]/[action] route.
 */
import { getRampBankAccounts } from "@/lib/ramp";
import { formatCurrencyCents } from "@/lib/format";
import { todayLocalDate } from "@/lib/utils/datetime";
import { listConnections, getConnection, recordSyncResult } from "../connections";
import { mostRecentlyEndedMonthEnd } from "../periods";
import { readRampBalance } from "../providers/rampBalance";
import { envPresent, type AdminClient, type SetupCandidate, type SetupCheckResult, type SetupHandler } from "./types";

export const rampSetup: SetupHandler = {
  provider: "ramp",

  readiness() {
    return envPresent("RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET")
      ? { configured: true }
      : {
          configured: false,
          reason: "Ramp is not set up for this app yet, so its accounts cannot be listed.",
        };
  },

  async candidates(supabase: AdminClient): Promise<SetupCandidate[]> {
    // listConnections cannot select the credentials column, so nothing secret
    // can reach the response even though Ramp stores none anyway.
    const [accounts, connections] = await Promise.all([getRampBankAccounts(), listConnections(supabase, "ramp")]);

    const byExternalId = new Map(connections.filter((c) => c.externalId).map((c) => [c.externalId as string, c]));

    return accounts.map((a) => ({
      externalId: a.id,
      label: a.name,
      sublabel: a.account_type ?? null,
      connectionId: byExternalId.get(a.id)?.id ?? null,
    }));
  },

  /**
   * Runs the REAL read, not a lighter one.
   *
   * `readRampBalance` is the same function the provider's compute() calls, on
   * the same window, applying the same exact-date and currency rules. A check
   * with its own simpler query could pass while the real read fails, which is
   * the one outcome a validation exists to rule out.
   *
   * The period checked is the most recently COMPLETED month, because that is
   * the first period the snapshot would write. It writes no balance:
   * gl_account_balances has exactly one writer, and a second write path from a
   * Settings button is how the frozen-period rules start being bypassed.
   */
  async check(supabase: AdminClient, connectionId: string): Promise<SetupCheckResult> {
    // getConnection, not getConnectionWithSecrets: Ramp authenticates from env,
    // so there is no per-connection secret to fetch and no reason to load one.
    const connection = await getConnection(supabase, connectionId);
    if (!connection) return { ok: false, reason: "That connection no longer exists." };
    if (connection.provider !== "ramp") return { ok: false, reason: "That connection is not a Ramp connection." };

    const today = todayLocalDate();
    const periodEnd = mostRecentlyEndedMonthEnd(today);
    const result = await readRampBalance(connection, periodEnd, today);

    await recordSyncResult(supabase, connectionId, result.ok ? { ok: true } : { ok: false, error: result.reason });

    return result.ok
      ? {
          ok: true,
          detail: `Read ${formatCurrencyCents(result.balanceCents)} for ${periodEnd}.`,
        }
      : { ok: false, reason: result.reason };
  },
};
