/**
 * The Ramp CARD setup: confirm which Ramp business's cards this account is for,
 * and prove the balance reads.
 *
 * ── Why there is one candidate and not a list ────────────────────────────────
 * Ramp reports ONE outstanding balance for the whole card programme, not one
 * per card. `/limits` does report per-card figures, but those are spend against
 * a monthly budget that resets on the 1st, not debt -- so a per-card picker
 * would offer a list of real-looking numbers, none of which is what GL 2110
 * owes. The single candidate is honest about that: there is exactly one thing
 * here to connect to.
 *
 * The business id is still stored as the connection's external_id rather than
 * left null. It is what the balance belongs to, it makes the (provider,
 * external id) unique index mean something, and a connection naming nothing is
 * indistinguishable from one an operator abandoned half way through.
 *
 * Shares Ramp's app-level credentials, so `readiness` asks the same question
 * ramp.ts does. Nothing separate to sign in to.
 */
import { getRampBusiness } from "@/lib/ramp";
import { formatCurrencyCents } from "@/lib/format";
import { listConnections, getConnection, recordSyncResult } from "../connections";
import { readRampCardBalance } from "../providers/rampCardBalance";
import { envPresent, type AdminClient, type SetupCandidate, type SetupCheckResult, type SetupHandler } from "./types";

export const rampCardSetup: SetupHandler = {
  provider: "rampCard",

  readiness() {
    return envPresent("RAMP_CLIENT_ID", "RAMP_CLIENT_SECRET")
      ? { configured: true }
      : {
          configured: false,
          reason: "Ramp is not set up for this app yet, so its card balance cannot be read.",
        };
  },

  async candidates(supabase: AdminClient): Promise<SetupCandidate[]> {
    const [business, connections] = await Promise.all([getRampBusiness(), listConnections(supabase, "rampCard")]);

    const existing = connections.find((c) => c.externalId === business.id);

    return [
      {
        externalId: business.id,
        label: `${business.card_name || business.legal_name} cards`,
        sublabel: "Everything owed on your Ramp cards",
        connectionId: existing?.id ?? null,
      },
    ];
  },

  /**
   * Runs the REAL read, on the same function the snapshot and the daily capture
   * call, so a check cannot pass on a path the balance does not take.
   *
   * Unlike the treasury check there is no period to name: the endpoint answers
   * only about now. So this proves the connection reads TODAY, which is also
   * precisely what the nightly capture will do. It writes no balance --
   * gl_account_daily_balances has one writer, and a second write path from a
   * Settings button is how the capture's "one reading per day, taken late in
   * the day" rule starts being bypassed.
   */
  async check(supabase: AdminClient, connectionId: string): Promise<SetupCheckResult> {
    const connection = await getConnection(supabase, connectionId);
    if (!connection) return { ok: false, reason: "That connection no longer exists." };
    if (connection.provider !== "rampCard") {
      return { ok: false, reason: "That connection is not a Ramp card connection." };
    }

    const result = await readRampCardBalance(connection);

    await recordSyncResult(supabase, connectionId, result.ok ? { ok: true } : { ok: false, error: result.reason });

    // Reported as the amount OWED, so the sentence back to the operator matches
    // what Ramp's own screen says. The stored balance is the negative of it,
    // which is a bookkeeping convention and not something to explain here.
    return result.ok
      ? { ok: true, detail: `Read ${formatCurrencyCents(-result.owedCents)} owed on the Ramp cards right now.` }
      : { ok: false, reason: result.reason };
  },
};
