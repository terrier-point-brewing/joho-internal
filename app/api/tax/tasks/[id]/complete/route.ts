/**
 * Marks a filing task as submitted/completed — confirmation number, amount
 * paid, submission date, and any notes, plus who completed it (from the
 * session user). Manager+ (same gate as recompute/autosave); admin remains
 * implicitly allowed via `requireRole`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { completeTask } from "@/lib/tax/tasks";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const session = await getSessionUser();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const body = (await req.json()) as {
      confirmation_number: string | null;
      amount_paid_cents: number | null;
      submitted_on: string | null;
      notes: string | null;
    };

    const sb = createSupabaseAdminClient();
    const task = await completeTask(sb, id, { ...body, userId: session.user.id });
    return NextResponse.json(task);
  } catch (err) {
    return apiError(err);
  }
}
