/**
 * GET    /api/finance/duplicates
 *   Pairs of records that look like one transaction ingested twice, split into
 *   those still waiting for an answer and those already reviewed.
 *
 * POST   /api/finance/duplicates  { key, resolution, note? }
 *   One person's answer to one pair. "duplicate_set_aside" also sets the extra
 *   record aside (see lib/finance/duplicateReview.ts); the other two only
 *   record the decision.
 *
 * DELETE /api/finance/duplicates?key=…
 *   Takes an answer back so the pair is asked about again.
 *
 * Admin client: duplicate_candidate_reviews, expenses and bank_ledger are all
 * lock-down RLS, so authorization is enforced here via requirePermission.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  listDuplicateReview,
  resolveDuplicate,
  reopenDuplicateReview,
  isDuplicateResolution,
} from "@/lib/finance/duplicateReview";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }
  try {
    return NextResponse.json(await listDuplicateReview(createSupabaseAdminClient()));
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const body = (await req.json()) as { key?: string; resolution?: string; note?: string | null };
    if (typeof body.key !== "string" || body.key === "") {
      return NextResponse.json({ error: "key is required" }, { status: 400 });
    }
    if (!isDuplicateResolution(body.resolution)) {
      return NextResponse.json({ error: "resolution must be not_duplicate, duplicate_set_aside or duplicate_corrected" }, { status: 400 });
    }

    // An answer is attributed, so it needs a real signed-in user.
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: "Sign in again before reviewing a duplicate." }, { status: 401 });

    const result = await resolveDuplicate(createSupabaseAdminClient(), {
      key: body.key,
      resolution: body.resolution,
      note: body.note ?? null,
      userId: session.user.id,
    });
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.error }, { status: result.status });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  try {
    const key = req.nextUrl.searchParams.get("key");
    if (!key) return NextResponse.json({ error: "key is required" }, { status: 400 });
    const result = await reopenDuplicateReview(createSupabaseAdminClient(), key);
    return result.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: result.error }, { status: result.status });
  } catch (err) {
    return apiError(err);
  }
}
