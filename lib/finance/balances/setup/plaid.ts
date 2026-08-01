/**
 * Plaid's setup: sign in at the bank, then pick an account on the link.
 *
 * The only `authorize` flow, and the only place a live bank credential exists
 * in this codebase.
 *
 * ── Why the credential never touches a request body ──────────────────────────
 * The browser only ever holds a PUBLIC token: single-use, ~30 minutes, and
 * worthless without the app secret. The long-lived access_token is minted here,
 * server-side, and goes straight into integration_connections.credentials via
 * writeCredentials(). It is in no response and no request, so it cannot reach a
 * request log. The generic connections route rejects `credentials` with a 400
 * for the same reason.
 *
 * ── Two steps, not one ───────────────────────────────────────────────────────
 * `complete` stores the credential and returns the accounts on the link; it
 * does NOT choose which one feeds the GL. A link can carry a checking and a
 * savings, and picking the first would be silently wrong. The choice is written
 * as the connection's external_id, exactly as the other two services do.
 */
import { createLinkToken, createUpdateLinkToken, exchangePublicToken, getAccountBalances, isDepository } from "@/lib/plaid";
import { upsertConnection, writeCredentials, getConnection, getConnectionWithSecrets } from "../connections";
import { envPresent, type AdminClient, type SetupCandidate, type SetupCheckResult, type SetupHandler } from "./types";

export const plaidSetup: SetupHandler = {
  provider: "plaid",

  readiness() {
    return envPresent("PLAID_CLIENT_ID", "PLAID_SECRET")
      ? { configured: true }
      : {
          configured: false,
          // Deliberately says what is true rather than naming environment
          // variables at a bookkeeper. The previous screen had no check at all
          // and surfaced the raw "Missing required environment variable:
          // PLAID_CLIENT_ID" from a button press.
          reason:
            "Plaid has not been set up for this app yet, so a bank cannot be connected. This needs a Plaid account and its keys added to the app first.",
        };
  },

  async authorize(supabase: AdminClient, args: { actorId: string; connectionId?: string }) {
    if (!args.connectionId) {
      const { linkToken } = await createLinkToken(args.actorId);
      return { token: linkToken, mode: "create" as const };
    }

    const connection = await getConnectionWithSecrets(supabase, args.connectionId);
    if (!connection) throw new Error("That connection no longer exists.");

    const accessToken = connection.credentials.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      // Nothing to repair -- this row never completed setup, so it needs a
      // fresh link rather than an update-mode one.
      throw new Error("That connection has no stored credential. Connect the bank again instead.");
    }

    const { linkToken } = await createUpdateLinkToken(args.actorId, accessToken);
    return { token: linkToken, mode: "update" as const };
  },

  async complete(
    supabase: AdminClient,
    args: { actorId: string; payload: string; label?: string; connectionId?: string },
  ): Promise<{ connectionId: string; candidates: SetupCandidate[] }> {
    const { accessToken, itemId } = await exchangePublicToken(args.payload.trim());

    const existing = args.connectionId ? await getConnection(supabase, args.connectionId) : null;
    if (args.connectionId && !existing) throw new Error("That connection no longer exists.");

    // Created before the credential is stored so there is a row to store it
    // against. `itemId` is not a secret -- it names the link, it cannot read
    // it -- so it belongs in config alongside the account choice.
    const connection = await upsertConnection(
      supabase,
      {
        id: existing?.id,
        provider: "plaid",
        label: args.label?.trim() || existing?.label || "Bank",
        externalId: existing?.externalId ?? null,
        config: { ...(existing?.config ?? {}), itemId },
      },
      args.actorId,
    );

    // Sets status back to active and clears last_error, which is what turns a
    // needs_reauth row healthy again after a repair.
    await writeCredentials(supabase, connection.id, { access_token: accessToken });

    const accounts = await getAccountBalances(accessToken);

    return {
      connectionId: connection.id,
      // Balances deliberately omitted. This exists so an operator can identify
      // an account, not so the browser can render a bank balance from an
      // unrecorded live read. Deposit accounts only -- balance-sheet cash
      // cannot come from a credit card or a loan.
      candidates: accounts.filter(isDepository).map((a) => ({
        externalId: a.account_id,
        label: a.official_name ?? a.name,
        sublabel: a.mask ? `····${a.mask} · ${a.subtype ?? a.type}` : (a.subtype ?? a.type),
      })),
    };
  },

  /**
   * Proves the stored credential still works by reading the bank right now.
   *
   * It records nothing. The daily capture job is the only writer of
   * gl_account_balances daily rows, and a reading taken at check time belongs
   * to the moment it was taken -- storing it here under today's date would
   * duplicate that job's decision about which date a real-time read represents.
   */
  async check(supabase: AdminClient, connectionId: string): Promise<SetupCheckResult> {
    const connection = await getConnectionWithSecrets(supabase, connectionId);
    if (!connection) return { ok: false, reason: "That connection no longer exists." };
    if (connection.provider !== "plaid") return { ok: false, reason: "That connection is not a bank connection." };

    const accessToken = connection.credentials.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      return { ok: false, reason: "This bank has not finished connecting. Sign in at your bank again." };
    }
    if (!connection.externalId) {
      return { ok: false, reason: "No account has been chosen on this bank link yet." };
    }

    try {
      const accounts = await getAccountBalances(accessToken);
      const chosen = accounts.find((a) => a.account_id === connection.externalId);
      if (!chosen) {
        return { ok: false, reason: "The chosen account is no longer on this bank link. Choose one again." };
      }
      return { ok: true, detail: "Your bank answered and the chosen account is still there." };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  },
};
