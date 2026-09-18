import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { REQUEST_BUCKET, type RequestFile } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

// GET /api/production/partner-requests/:id/file?i=0 — a short-lived link to
// one file the partner attached. The path comes from the row, never the URL.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try { await requirePermission(CAP.partnersRead); } catch (res) { return res as Response; }
  const { id } = await params;
  const index = Number(req.nextUrl.searchParams.get("i") ?? 0);
  const admin = createSupabaseAdminClient();
  const { data } = await admin.from("partner_requests").select("files").eq("id", id).maybeSingle();
  const file = ((data?.files ?? []) as RequestFile[])[index];
  if (!file) return NextResponse.json({ error: "File not found." }, { status: 404 });
  const { data: signed, error } = await admin.storage.from(REQUEST_BUCKET).createSignedUrl(file.path, 60, { download: file.name });
  if (error || !signed) return NextResponse.json({ error: error?.message ?? "Could not open the file." }, { status: 500 });
  return NextResponse.redirect(signed.signedUrl);
}
