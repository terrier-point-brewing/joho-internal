/**
 * Receiving-party tax authorities registry (`tax_authorities`, see
 * lib/tax/authorities.ts) — the agencies TPB files/pays excise to (NC DOR,
 * TTB, ...). GET lists all authorities; PATCH (admin-only) updates a single
 * authority's registration number by key.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listAuthorities, updateRegistration } from "@/lib/tax/authorities";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireRole(["manager"]); } catch (res) { return res as Response; }

  try {
    const sb = createSupabaseAdminClient();
    return NextResponse.json(await listAuthorities(sb));
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  try {
    const body = (await req.json()) as { key: string; registration_number: string | null };
    if (!body.key || typeof body.key !== "string") {
      return apiError(new Error("key is required"), 400);
    }
    const sb = createSupabaseAdminClient();
    await updateRegistration(sb, body.key, body.registration_number ?? null);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
