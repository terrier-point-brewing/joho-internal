import { NextRequest, NextResponse } from "next/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requirePartner } from "@/lib/partner/portal.server";
import { listRequestsForPartner, RequestError, submitRequest } from "@/lib/partner/requests.server";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  return NextResponse.json(await listRequestsForPartner(createSupabaseAdminClient(), caller.partnerId));
}

// POST multipart/form-data: `payload` (JSON) + any number of `files`.
export async function POST(req: NextRequest) {
  let caller;
  try { caller = await requirePartner(req); } catch (res) { return res as Response; }
  // A preview is for looking. Staff who want a deal on the books write a commitment.
  if (caller.preview) return NextResponse.json({ error: "Preview mode cannot submit requests." }, { status: 403 });

  const form = await req.formData().catch(() => null);
  let payload: Record<string, unknown> | null = null;
  try { payload = JSON.parse(String(form?.get("payload") ?? "")); } catch { /* handled below */ }
  if (!form || !payload) return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);

  try {
    const created = await submitRequest(createSupabaseAdminClient(), { partnerId: caller.partnerId, userId: caller.session.user.id }, payload, files);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    if (e instanceof RequestError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
