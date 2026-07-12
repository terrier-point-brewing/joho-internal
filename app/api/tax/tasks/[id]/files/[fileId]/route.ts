/**
 * Single confirmation file. GET returns a short-lived signed URL (the
 * bucket is private, so this is the only way to download it); DELETE
 * removes the storage object then the row. Manager+ (same gate as the
 * other task routes). The task `id` in the path IS required by both
 * operations — it scopes the file lookup so a fileId belonging to a
 * different task can't be read or deleted through this route.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { signedUrlForFile, deleteTaskFile } from "@/lib/tax/files";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id, fileId } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const url = await signedUrlForFile(sb, id, fileId);
    return NextResponse.json({ url });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; fileId: string }> }
) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id, fileId } = await params;
  try {
    const sb = createSupabaseAdminClient();
    await deleteTaskFile(sb, id, fileId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
