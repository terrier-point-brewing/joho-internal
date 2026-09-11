/**
 * Single filing-form template. GET returns a short-lived signed URL (the
 * bucket is private, so this is the only way to download it); DELETE
 * removes the storage object then the row. The party `key` in the path IS
 * required by both operations — it scopes the file lookup so a fileId
 * belonging to a different party can't be read or deleted through this
 * route. Same gates as the task-file routes.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { signedUrlForFormFile, deleteFormFile } from "@/lib/tax/files";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string; fileId: string }> }
) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  const { key, fileId } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const url = await signedUrlForFormFile(sb, key, fileId);
    return NextResponse.json({ url });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ key: string; fileId: string }> }
) {
  try { await requirePermission(CAP.taxOperate); } catch (res) { return res as Response; }

  const { key, fileId } = await params;
  try {
    const sb = createSupabaseAdminClient();
    await deleteFormFile(sb, key, fileId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
