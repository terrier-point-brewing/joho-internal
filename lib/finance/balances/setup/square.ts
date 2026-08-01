/**
 * Square's setup: pick the business, then supply a starting balance.
 *
 * Only the first half lives here. The second is an `operatorBalance` setup
 * field on the method, which is the same mechanism manual entry uses and which
 * is what raises the month-end close task -- so this handler does not know
 * about anchors at all. Its predecessor route did, and duplicated the
 * manual-entry writer to do it.
 *
 * Square authenticates with one business-wide token from env, shared with every
 * other Square reader in the app. There is nothing to sign in to and no
 * per-connection secret, so this is a `discover` flow like Ramp's.
 */
import { squareGetAll } from "@/lib/square/client";
import { formatCurrencyCents } from "@/lib/format";
import { sumNetPayoutCents } from "@/lib/square/payouts";
import { todayLocalDate } from "@/lib/utils/datetime";
import { listConnections, getConnection, recordSyncResult } from "../connections";
import { addDaysStr } from "@/lib/utils/datetime";
import { envPresent, type AdminClient, type SetupCandidate, type SetupCheckResult, type SetupHandler } from "./types";

interface RawLocation {
  id: string;
  name?: string;
  status?: string;
}

export const squareSetup: SetupHandler = {
  provider: "square",

  readiness() {
    return envPresent("SQUARE_ACCESS_TOKEN")
      ? { configured: true }
      : {
          configured: false,
          reason: "Square is not set up for this app yet, so its businesses cannot be listed.",
        };
  },

  async candidates(supabase: AdminClient): Promise<SetupCandidate[]> {
    const [locations, connections] = await Promise.all([
      squareGetAll<RawLocation>("/locations", "locations"),
      listConnections(supabase, "square"),
    ]);

    const byExternalId = new Map(connections.filter((c) => c.externalId).map((c) => [c.externalId as string, c]));

    return locations
      .filter((l) => l.status !== "INACTIVE")
      .map((l) => ({
        externalId: l.id,
        label: l.name ?? l.id,
        sublabel: null,
        connectionId: byExternalId.get(l.id)?.id ?? null,
      }));
  },

  /**
   * Reads the movement half through the same function the provider uses.
   *
   * Deliberately checks only what this handler is responsible for. Whether an
   * anchor exists is the operatorBalance field's business, and the setup panel
   * already reports that separately -- a check that folded the two together
   * would report "not working" for an account whose Square side is perfectly
   * healthy and simply has not been anchored yet.
   */
  async check(supabase: AdminClient, connectionId: string): Promise<SetupCheckResult> {
    const connection = await getConnection(supabase, connectionId);
    if (!connection) return { ok: false, reason: "That connection no longer exists." };
    if (connection.provider !== "square") return { ok: false, reason: "That connection is not a Square connection." };

    const today = todayLocalDate();
    try {
      const cents = await sumNetPayoutCents(addDaysStr(today, -30), today);
      await recordSyncResult(supabase, connectionId, { ok: true });
      return {
        ok: true,
        detail: `Square settled ${formatCurrencyCents(cents)} into this account over the last 30 days.`,
      };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await recordSyncResult(supabase, connectionId, { ok: false, error: reason }).catch(() => {});
      return { ok: false, reason };
    }
  },
};
