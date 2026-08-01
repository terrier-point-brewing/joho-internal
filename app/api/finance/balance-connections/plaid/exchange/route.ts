/**
 * POST /api/finance/balance-connections/plaid/exchange
 *   { publicToken, label?, id? }
 *   -> { connectionId, accounts: [{ id, name, mask, type, subtype }] }
 *
 * The one place a live bank credential exists in this codebase, and the reason
 * integration_connections.credentials exists at all.
 *
 * ── Why this is not the generic connections route ────────────────────────────
 * PUT /api/finance/balance-connections deliberately rejects `credentials` with
 * a 400 rather than dropping it, because a request body reaches request logs.
 * Plaid's access_token is not sent by the browser — the browser only ever holds
 * a public token, which is single-use, expires in 30 minutes and is worthless
 * without the app secret. The long-lived token is minted HERE, server-side, and
 * goes straight into the store via writeCredentials(). It is never in a
 * response body, and the accounts list returned below deliberately carries no
 * balances and no token.
 *
 * ── Two-step by design ───────────────────────────────────────────────────────
 * The exchange creates the connection and stores the credential; it does NOT
 * choose which account on the item feeds the GL. An item can carry a checking
 * and a savings, and picking the first would be silently wrong. So this returns
 * the accounts, and the operator's choice is written through the shared PUT
 * route as `externalId` — which is the flow every integration follows.
 *
 * Passing `id` re-exchanges into an EXISTING connection, which is what an
 * update-mode (repair) link produces. The row, its account choice and its
 * captured history all survive.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { exchangePublicToken, getAccountBalances } from "@/lib/plaid";
import { upsertConnection, writeCredentials, getConnection } from "@/lib/finance/balances/connections";

export const dynamic = "force-dynamic";
/** The accounts call is synchronous against the bank and can take ~30s. */
export const maxDuration = 60;

interface Body {
  publicToken?: string;
  label?: string;
  /** Set when repairing an existing connection rather than creating one. */
  id?: string;
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as Body;
    if (typeof body.publicToken !== "string" || body.publicToken.trim() === "") {
      return NextResponse.json({ error: "publicToken is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { accessToken, itemId } = await exchangePublicToken(body.publicToken.trim());

    const existing = body.id ? await getConnection(supabase, body.id) : null;
    if (body.id && !existing) {
      return NextResponse.json({ error: "That connection no longer exists." }, { status: 404 });
    }

    // Created before the credential is stored so there is a row to store it
    // against. `itemId` is not a secret -- it names the link, it cannot read
    // it -- so it belongs in config alongside the account choice.
    const connection = await upsertConnection(
      supabase,
      {
        id: existing?.id,
        provider: "plaid",
        label: body.label?.trim() || existing?.label || "Bank",
        externalId: existing?.externalId ?? null,
        config: { ...(existing?.config ?? {}), itemId },
      },
      session.user.id,
    );

    // Sets status back to active and clears last_error, which is what turns a
    // needs_reauth row healthy again after a repair.
    await writeCredentials(supabase, connection.id, { access_token: accessToken });

    const accounts = await getAccountBalances(accessToken);

    return NextResponse.json({
      connectionId: connection.id,
      // Balances deliberately omitted. This response exists so an operator can
      // identify an account, not so the browser can render a bank balance from
      // an unrecorded live read.
      accounts: accounts.map((a) => ({
        id: a.account_id,
        name: a.official_name ?? a.name,
        mask: a.mask,
        type: a.type,
        subtype: a.subtype,
      })),
    });
  } catch (err) {
    return apiError(err);
  }
}
