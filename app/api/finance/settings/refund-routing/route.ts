/**
 * Refund routing rules — which account a refund posts to when the default
 * contra-revenue account (GL 4999) is the wrong answer.
 *
 * Thin wrapper over `refund_gl_routing`. See lib/finance/refundRouting.ts for
 * how a rule is applied at sync time, and 20261013090001_refund_gl_routing.sql
 * for why the rule is data rather than a special case for GL 2420.
 *
 * POST creates a rule, PATCH edits or deactivates one, DELETE removes one
 * outright. Deactivating is the normal way to stop a rule — it keeps the row as
 * the record of what refunds used to be routed by — so the UI offers that and
 * DELETE exists for a rule added by mistake.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { fetchAllRows } from "@/lib/supabase/paginate";

export const dynamic = "force-dynamic";

interface CoaJoin {
  account_name: string;
  account_number: string | null;
}

export interface RefundRoutingRow {
  id: string;
  source_chart_of_accounts_id: string;
  target_chart_of_accounts_id: string;
  active: boolean;
  note: string | null;
  source_account: CoaJoin | null;
  target_account: CoaJoin | null;
}

const SELECT =
  "id, source_chart_of_accounts_id, target_chart_of_accounts_id, active, note, " +
  "source_account:chart_of_accounts!refund_gl_routing_source_chart_of_accounts_id_fkey ( account_name, account_number ), " +
  "target_account:chart_of_accounts!refund_gl_routing_target_chart_of_accounts_id_fkey ( account_name, account_number )";

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  try {
    const sb = createSupabaseAdminClient();
    // Paged on the primary key rather than on an account number: the joined
    // number is nullable and non-unique, and an unstable sort key makes range
    // paging drop or duplicate rows. Display order is applied below.
    const rows = await fetchAllRows<RefundRoutingRow>(() =>
      sb.from("refund_gl_routing").select(SELECT).order("id", { ascending: true }),
    );
    rows.sort((a, b) =>
      (a.source_account?.account_number ?? "").localeCompare(b.source_account?.account_number ?? ""),
    );
    return NextResponse.json(rows);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = await req.json() as {
      source_chart_of_accounts_id?: string;
      target_chart_of_accounts_id?: string;
      note?: string | null;
    };
    if (!body.source_chart_of_accounts_id || !body.target_chart_of_accounts_id) {
      return NextResponse.json(
        { error: "source_chart_of_accounts_id and target_chart_of_accounts_id are both required" },
        { status: 400 },
      );
    }

    const { data, error } = await createSupabaseAdminClient()
      .from("refund_gl_routing")
      .insert({
        source_chart_of_accounts_id: body.source_chart_of_accounts_id,
        target_chart_of_accounts_id: body.target_chart_of_accounts_id,
        note: body.note ?? null,
      })
      .select("id")
      .single();

    // 23505 is refund_gl_routing_one_active_per_source. Answered with a
    // sentence rather than a raw constraint name for the same reason the
    // balance-sources route does: two active rules on one account would make
    // routing depend on row order, and the operator needs to be told what to do
    // about it, not shown the index that stopped them.
    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "That account already has an active refund rule. Turn the existing one off first, or edit it." },
          { status: 409 },
        );
      }
      throw new Error(error.message);
    }
    return NextResponse.json({ ok: true, id: data.id });
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = await req.json() as {
      id?: string;
      target_chart_of_accounts_id?: string;
      active?: boolean;
      note?: string | null;
    };
    if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });

    // Only the fields actually present are touched, so toggling `active` never
    // clobbers a note and vice versa — same split as the sales-tax PATCH.
    const update: Record<string, unknown> = {};
    if ("target_chart_of_accounts_id" in body && body.target_chart_of_accounts_id) {
      update.target_chart_of_accounts_id = body.target_chart_of_accounts_id;
    }
    if ("active" in body) update.active = body.active;
    if ("note" in body) update.note = body.note ?? null;
    if (Object.keys(update).length === 0) return NextResponse.json({ ok: true });

    // `updated_at` is deliberately absent: one trigger owns it.
    const { error } = await createSupabaseAdminClient()
      .from("refund_gl_routing")
      .update(update)
      .eq("id", body.id);

    if (error) {
      if (error.code === "23505") {
        return NextResponse.json(
          { error: "That account already has another active refund rule. Turn that one off first." },
          { status: 409 },
        );
      }
      throw new Error(error.message);
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { error } = await createSupabaseAdminClient().from("refund_gl_routing").delete().eq("id", id);
    if (error) throw new Error(error.message);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
