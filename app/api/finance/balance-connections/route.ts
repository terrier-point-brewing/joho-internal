/**
 * GET    /api/finance/balance-connections            every connection, no secrets
 * PUT    /api/finance/balance-connections            create or update one, no secrets
 * DELETE /api/finance/balance-connections  { id }    remove one
 *
 * Shared across Ramp, Plaid and Square so the three integrations do not each
 * build their own write path with their own authorization decisions. Each still
 * owns its provider-specific SETUP flow -- picking a Ramp treasury account,
 * running Plaid Link, entering a Square anchor -- and calls PUT here with the
 * result.
 *
 * ── Secrets never traverse this route ────────────────────────────────────────
 * `credentials` is accepted on neither verb and returned by neither. Plaid's
 * access_token is produced by exchanging a public token server-side, which
 * belongs in that integration's own route; sending it through a generic
 * endpoint would put a live bank credential in a request log. Server-side code
 * writes secrets with writeCredentials(), which nothing here can reach.
 *
 * Admin client behind requirePermission, matching balance-sources: these tables
 * are lock-down-only under RLS, so a session-scoped client would silently read
 * zero rows.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listConnections,
  upsertConnection,
  deleteConnection,
  type ConnectionProvider,
  type ConnectionState,
} from "@/lib/finance/balances/connections";

export const dynamic = "force-dynamic";

const PROVIDERS: readonly ConnectionProvider[] = ["ramp", "rampCard", "plaid", "square"];

function isProvider(value: unknown): value is ConnectionProvider {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value);
}

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const connections = await listConnections(createSupabaseAdminClient());
    return NextResponse.json({ connections });
  } catch (err) {
    return apiError(err);
  }
}

interface PutBody {
  id?: string;
  provider?: string;
  label?: string;
  externalId?: string | null;
  config?: Record<string, unknown>;
  status?: string;
}

const STATUSES = ["active", "needs_reauth", "disabled", "error"];

export async function PUT(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as PutBody;

    if (!isProvider(body.provider)) {
      return NextResponse.json(
        { error: `provider must be one of ${PROVIDERS.join(", ")}` },
        { status: 400 },
      );
    }
    if (typeof body.label !== "string" || body.label.trim() === "") {
      return NextResponse.json({ error: "label is required" }, { status: 400 });
    }
    if (body.status !== undefined && !STATUSES.includes(body.status)) {
      return NextResponse.json({ error: `status must be one of ${STATUSES.join(", ")}` }, { status: 400 });
    }
    // Reject rather than silently drop: a caller that thinks it is storing a
    // secret here needs to find out, not to succeed and leave the credential
    // unset while believing otherwise.
    if ("credentials" in body) {
      return NextResponse.json(
        { error: "credentials cannot be set through this route; write them server-side" },
        { status: 400 },
      );
    }

    const connection = await upsertConnection(
      createSupabaseAdminClient(),
      {
        id: body.id,
        provider: body.provider,
        label: body.label.trim(),
        externalId: body.externalId ?? null,
        config: body.config,
        status: body.status as ConnectionState | undefined,
      },
      session.user.id,
    );

    return NextResponse.json(connection);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const { id } = (await req.json()) as { id?: string };
    if (typeof id !== "string" || id.trim() === "") {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    await deleteConnection(createSupabaseAdminClient(), id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
