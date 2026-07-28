/**
 * Brand labels — admin-gated list + create. GET lists rows (optionally
 * filtered by `?status=`) for the admin labels editor; approved reads for
 * guide rendering go through `resolveApprovedLabels` directly, not this
 * route. POST creates a new draft label. Mirrors
 * `app/api/brand/assets/route.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { listLabels, createLabel, type BrandLabel, type SupabaseLikeClient } from "@/lib/brand/labels";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.brandReleasesRead); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const status = new URL(req.url).searchParams.get("status") as BrandLabel["status"] | null;
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const labels = await listLabels(supabase, status ? { status } : undefined);
    return NextResponse.json(labels);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePermission(CAP.brandReleasesManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json()) as {
      name?: string;
      subtitle?: string;
      description?: string;
      motif_family?: string;
    };
    if (!body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const label = await createLabel(supabase, {
      name: body.name,
      subtitle: body.subtitle,
      description: body.description,
      motif_family: body.motif_family,
    });
    return NextResponse.json(label, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
