/**
 * Confirmation files attached to a tax filing task. POST accepts
 * multipart/form-data (field "file", optional "label") and uploads to the
 * private tax-confirmations Storage bucket via the service-role admin
 * client (the bucket has no object-level RLS policies, so this route is
 * the only path in — no other route or client role may touch it). GET
 * lists the task's files. Manager+ (same gate as the other task routes).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { uploadTaskFile, listTaskFiles } from "@/lib/tax/files";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxOperate); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }
    const labelRaw = formData.get("label");
    const label = typeof labelRaw === "string" ? labelRaw : null;

    const session = await getSessionUser();
    const sb = createSupabaseAdminClient();
    const row = await uploadTaskFile(sb, id, {
      file,
      fileName: file.name,
      label,
      userId: session?.user.id ?? null,
    });
    return NextResponse.json(row, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const files = await listTaskFiles(sb, id);
    return NextResponse.json(files);
  } catch (err) {
    return apiError(err);
  }
}
