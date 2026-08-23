/**
 * Start connecting a channel: mint a CSRF `state`, remember it, and send the
 * browser to the provider.
 *
 * ── Why this is `accounts/connect/[channel]` and not `accounts/[channel]/connect`
 * The brief asks for `[channel]/connect`, `[channel]/callback` and
 * `[id]/disconnect`. Next.js will not route that layout, and the two keys are
 * genuinely different — a connect is addressed by a channel that has no row
 * yet, a disconnect by the row id of one that does — so neither name can be
 * made to lie. The channel-keyed pair therefore moved a segment left.
 *
 * Worth knowing, because it is the trap: **`next build` accepts the two-slug
 * layout and `next dev` does not.** Building it lists both routes happily; the
 * dev server throws "You cannot use different slug names for the same dynamic
 * path ('channel' !== 'id')" the moment it serves anything. Confirmed both ways
 * on 16.2.6. A green build is not evidence here.
 *
 * Nothing else changes: same three operations, same guard, same registry lookup.
 *
 * ── Where `state` lives ─────────────────────────────────────────────────────
 * In a signed, ten-minute, httpOnly cookie — no table, and see
 * lib/marketing/oauthState.ts for why a cookie is not merely the cheap option
 * but the right-shaped one.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { getChannel } from "@/lib/marketing/plugins/registry";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  createOAuthState,
  oauthStateSecret,
} from "@/lib/marketing/oauthState";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, context: { params: Promise<{ channel: string }> }) {
  try {
    await requirePermission(CAP.marketingAccountsManage);
  } catch (res) {
    return res as Response;
  }

  const { channel } = await context.params;
  try {
    // Through the registry, always. No route in marketing names a channel in
    // its own source, which is what makes adding one a folder and a line.
    const plugin = getChannel(channel);
    if (!plugin) {
      return apiError(`There is no channel called "${channel}".`, 404);
    }

    const state = createOAuthState(channel, oauthStateSecret());
    // The plugin builds the provider URL and round-trips `state` verbatim. It
    // is the only thing here that knows what that URL looks like.
    const res = NextResponse.redirect(plugin.connect.authUrl(state));
    res.cookies.set(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      sameSite: "lax", // The provider redirects back with a top-level GET; strict would drop the cookie.
      secure: process.env.NODE_ENV === "production",
      path: "/api/marketing/accounts",
      maxAge: OAUTH_STATE_TTL_MS / 1000,
    });
    return res;
  } catch (err) {
    return apiError(err);
  }
}
