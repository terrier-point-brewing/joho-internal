/**
 * Gusto payroll-journal report for a pay period. POST accepts
 * multipart/form-data (field "file") and uploads/parses/persists it via
 * lib/payroll/gustoUpload.ts's uploadGustoReport, using the private
 * payroll-gl-reports Storage bucket through the service-role admin client
 * (the bucket has no object-level RLS policies, so this route is the only
 * path in). GET returns the period's active report + totals +
 * unmapped-department warnings. Manager+ (same gate as the tax task files
 * route).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionUser, requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { uploadGustoReport, getActiveGustoReport } from "@/lib/payroll/gustoUpload";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

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

    const session = await getSessionUser();
    const sb = createSupabaseAdminClient();
    const result = await uploadGustoReport(sb, {
      payPeriodId: id,
      file,
      fileName: file.name,
      userId: session!.user.id,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  const { id } = await params;
  try {
    const sb = createSupabaseAdminClient();
    const result = await getActiveGustoReport(sb, id);
    if (!result) return apiError("No Gusto report found for this period", 404);
    return NextResponse.json(result);
  } catch (err) {
    return apiError(err);
  }
}
