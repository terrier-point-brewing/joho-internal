/**
 * POST /api/finance/balance-connections/plaid/link-token           -> a token for a NEW bank link
 * POST /api/finance/balance-connections/plaid/link-token { id }    -> a token to REPAIR that connection
 *
 * The browser cannot create one itself: /link/token/create needs the app-level
 * client id and secret, which stay server-side.
 *
 * A link token is short-lived (minutes), single-session, and on its own confers
 * nothing — it opens a Link dialog the operator still has to authenticate
 * through. The long-lived credential appears only after the exchange, which is
 * a separate route and never returns it to the browser.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { createLinkToken, createUpdateLinkToken } from "@/lib/plaid";
import { getConnectionWithSecrets } from "@/lib/finance/balances/connections";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json().catch(() => ({}))) as { id?: string };

    if (typeof body.id === "string" && body.id.length > 0) {
      const connection = await getConnectionWithSecrets(createSupabaseAdminClient(), body.id);
      if (!connection) {
        return NextResponse.json({ error: "That connection no longer exists." }, { status: 404 });
      }
      const accessToken = connection.credentials.access_token;
      if (typeof accessToken !== "string" || accessToken.length === 0) {
        // Nothing to repair — this row never completed setup, so it needs a
        // fresh link rather than an update-mode one.
        return NextResponse.json(
          { error: "That connection has no stored credential. Connect the bank again instead." },
          { status: 409 },
        );
      }
      const { linkToken } = await createUpdateLinkToken(session.user.id, accessToken);
      return NextResponse.json({ linkToken, mode: "update" });
    }

    const { linkToken } = await createLinkToken(session.user.id);
    return NextResponse.json({ linkToken, mode: "create" });
  } catch (err) {
    return apiError(err);
  }
}
