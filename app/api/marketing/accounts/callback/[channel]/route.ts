/**
 * Finish connecting a channel.
 *
 * **`state` is verified before anything else happens** — before the code is
 * read, before the plugin is asked to exchange it, before a row is touched.
 * That order is the point of the route: everything after this line acts on a
 * value a stranger sent us, and the only thing standing between "a person
 * connected our Instagram" and "somebody attached their account to our brewery
 * with a link" is that the callback refuses outright when the state does not
 * match the connect this browser started.
 *
 * A mismatch is not a retry and not a redirect into the app. It is a refusal
 * with a sentence, and the half-finished cookie is cleared on the way out.
 *
 * See the sibling connect route for why these two live at
 * `accounts/{connect,callback}/[channel]` rather than `accounts/[channel]/…`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { upsertConnectedAccount } from "@/lib/marketing/accounts";
import { getChannel } from "@/lib/marketing/plugins/registry";
import { OAUTH_STATE_COOKIE, oauthStateSecret, verifyOAuthState } from "@/lib/marketing/oauthState";

export const dynamic = "force-dynamic";

/** Clear the one-shot state cookie. It is spent whichever way this request ends. */
function clearState(res: NextResponse): NextResponse {
  res.cookies.set(OAUTH_STATE_COOKIE, "", { httpOnly: true, path: "/api/marketing/accounts", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest, context: { params: Promise<{ channel: string }> }) {
  let session;
  try {
    session = await requirePermission(CAP.marketingAccountsManage);
  } catch (res) {
    return res as Response;
  }

  const { channel } = await context.params;
  const params = new URL(req.url).searchParams;

  try {
    // ── 1. state, first and unconditionally ──────────────────────────────
    const verdict = verifyOAuthState({
      state: params.get("state"),
      cookie: req.cookies.get(OAUTH_STATE_COOKIE)?.value ?? null,
      channel,
      secret: oauthStateSecret(),
    });
    if (!verdict.ok) {
      return clearState(apiError(verdict.reason, 400) as NextResponse);
    }

    // ── 2. everything else ───────────────────────────────────────────────
    const plugin = getChannel(channel);
    if (!plugin) return clearState(apiError(`There is no channel called "${channel}".`, 404) as NextResponse);

    const code = params.get("code");
    if (!code) {
      // A provider that sends `error=access_denied` instead of a code is a
      // person changing their mind, not a fault.
      const denied = params.get("error");
      return clearState(
        apiError(
          denied
            ? `The provider did not complete the connection (${denied}).`
            : "The provider did not send an authorization code back.",
          400,
        ) as NextResponse,
      );
    }

    const account = await plugin.connect.callback(code, params.get("state")!);

    // Upsert on (provider, channel): one brand means one login per channel, and
    // re-connecting must move the existing row rather than leave a second one
    // the worker might pick the stale half of.
    const stored = await upsertConnectedAccount(createSupabaseAdminClient(), account, {
      createdBy: session.user.id,
    });

    // `stored` was selected without the credentials column — see
    // lib/marketing/accounts.ts. The redirect carries a channel name and
    // nothing else; a token never belongs in a URL.
    const back = new URL(`/marketing/accounts?connected=${encodeURIComponent(stored.channel)}`, req.url);
    return clearState(NextResponse.redirect(back));
  } catch (err) {
    // The plugin's own failure message, exactly as the worker records one: the
    // contract puts sentence-writing on the plugin. Nothing from the account
    // row is added to it.
    return clearState(apiError(err, 502) as NextResponse);
  }
}
