/**
 * Single tax filing task. GET returns the full task (including worksheet);
 * PATCH is the worksheet autosave endpoint the editable-worksheet UI calls
 * on every field change. Both manager+ (finance write for the worksheet
 * itself, not the filing schedule/profile — those stay admin-only).
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getTask, saveWorksheet } from "@/lib/tax/tasks";
import type { WorksheetData } from "@/lib/tax/types";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const task = await getTask(sb, id);
    if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
    return NextResponse.json(task);
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const body = (await req.json()) as { worksheet: WorksheetData };
    const sb = createSupabaseAdminClient();
    const task = await saveWorksheet(sb, id, body.worksheet);
    return NextResponse.json(task);
  } catch (err) {
    return apiError(err);
  }
}
