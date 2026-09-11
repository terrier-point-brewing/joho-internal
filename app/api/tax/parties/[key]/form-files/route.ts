/**
 * Filing-form templates for one tax party module (e.g. a partially
 * prefilled B-C-710 PDF), managed from Settings → Tax Filing and listed
 * read-only on every period's task worksheet. POST accepts
 * multipart/form-data (field "file", optional "label") and uploads to the
 * private tax-confirmations Storage bucket via the service-role admin
 * client (the bucket has no object-level RLS policies, so these routes and
 * the task-file routes are the only paths in). GET lists the party's
 * templates. Same gates as the task-file routes: upload manager+
 * (taxOperate), list read (taxRead).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { uploadFormFile, listFormFiles } from "@/lib/tax/files";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try { await requirePermission(CAP.taxOperate); } catch (res) { return res as Response; }

  const { key } = await params;
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
    const row = await uploadFormFile(sb, key, {
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

export async function GET(_req: NextRequest, { params }: { params: Promise<{ key: string }> }) {
  try { await requirePermission(CAP.taxRead); } catch (res) { return res as Response; }

  const { key } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const files = await listFormFiles(sb, key);
    return NextResponse.json(files);
  } catch (err) {
    return apiError(err);
  }
}
