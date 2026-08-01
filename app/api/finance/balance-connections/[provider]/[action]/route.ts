/**
 * GET  /api/finance/balance-connections/{provider}/candidates
 *        What can be connected. `discover` services only.
 * POST /api/finance/balance-connections/{provider}/authorize   { connectionId? }
 *        Begin a browser sign-in. `authorize` services only.
 * POST /api/finance/balance-connections/{provider}/complete    { payload, label?, connectionId? }
 *        Finish it: store the credential server-side, return what can be chosen.
 * POST /api/finance/balance-connections/{provider}/check       { connectionId }
 *        Prove the connection reads right now.
 *
 * One route for every integration, replacing three differently-shaped ones
 * (`GET /ramp`, `POST /ramp/check`, `GET|POST /square`, `POST /plaid/link-token`,
 * `POST /plaid/exchange`). The behaviour is unchanged -- each service's logic
 * moved verbatim into lib/finance/balances/setup/<provider>.ts -- but the
 * CLIENT is now generic, which is the point: the setup panel drives any service
 * without knowing which one it is talking to.
 *
 * Creating and removing the connection row is still the shared PUT/DELETE on
 * the parent route, and attaching one to a GL account is still a config write
 * on balance-sources. Neither is rebuilt here.
 *
 * Manage-level throughout, not read-level: the only reason to list candidates
 * is to choose one, which is a configuration change.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getSetupHandler } from "@/lib/finance/balances/setup";

export const dynamic = "force-dynamic";
/** Plaid's exchange is synchronous against the bank and can take ~30s. */
export const maxDuration = 60;

type Params = { params: Promise<{ provider: string; action: string }> };

/**
 * Resolves the handler, or the response explaining why there isn't one.
 *
 * Readiness is checked here rather than in each handler so that an unconfigured
 * service answers the same way on every action, with the same sentence the
 * Settings panel already shows -- instead of the raw "Missing required
 * environment variable" a credential accessor throws.
 */
function resolveHandler(provider: string) {
  const handler = getSetupHandler(provider);
  if (!handler) {
    return { error: NextResponse.json({ error: `Unknown integration "${provider}".` }, { status: 404 }) };
  }
  const readiness = handler.readiness();
  if (!readiness.configured) {
    return { error: NextResponse.json({ error: readiness.reason }, { status: 409 }) };
  }
  return { handler };
}

export async function GET(_req: NextRequest, { params }: Params) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const { provider, action } = await params;
    if (action !== "candidates") {
      return NextResponse.json({ error: `"${action}" is not a GET action.` }, { status: 405 });
    }

    const resolved = resolveHandler(provider);
    if (resolved.error) return resolved.error;
    if (!resolved.handler.candidates) {
      return NextResponse.json(
        { error: `${provider} accounts cannot be listed until you have signed in.` },
        { status: 409 },
      );
    }

    return NextResponse.json({ candidates: await resolved.handler.candidates(createSupabaseAdminClient()) });
  } catch (err) {
    return apiError(err);
  }
}

interface PostBody {
  connectionId?: string;
  /** The short-lived artifact a browser sign-in produced. Never a credential. */
  payload?: string;
  label?: string;
}

export async function POST(req: NextRequest, { params }: Params) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const { provider, action } = await params;
    const resolved = resolveHandler(provider);
    if (resolved.error) return resolved.error;
    const handler = resolved.handler;

    const body = (await req.json().catch(() => ({}))) as PostBody;
    const supabase = createSupabaseAdminClient();
    const actorId = session.user.id;

    if (action === "authorize") {
      if (!handler.authorize) {
        return NextResponse.json({ error: `${provider} needs no sign-in.` }, { status: 409 });
      }
      return NextResponse.json(await handler.authorize(supabase, { actorId, connectionId: body.connectionId }));
    }

    if (action === "complete") {
      if (!handler.complete) {
        return NextResponse.json({ error: `${provider} has no sign-in to complete.` }, { status: 409 });
      }
      if (typeof body.payload !== "string" || body.payload.trim() === "") {
        return NextResponse.json({ error: "payload is required" }, { status: 400 });
      }
      return NextResponse.json(
        await handler.complete(supabase, {
          actorId,
          payload: body.payload,
          label: body.label,
          connectionId: body.connectionId,
        }),
      );
    }

    if (action === "check") {
      if (!handler.check) {
        return NextResponse.json({ error: `${provider} connections cannot be tested.` }, { status: 409 });
      }
      if (typeof body.connectionId !== "string" || body.connectionId.trim() === "") {
        return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
      }
      // A failed check is a RESULT, not an HTTP error: the operator asked a
      // question and "no, and here is why" is the answer to it.
      return NextResponse.json(await handler.check(supabase, body.connectionId.trim()));
    }

    return NextResponse.json({ error: `"${action}" is not a POST action.` }, { status: 405 });
  } catch (err) {
    return apiError(err);
  }
}
