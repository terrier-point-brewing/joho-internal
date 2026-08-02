/**
 * Brand releases — admin-gated list + create. GET lists release rows
 * (optionally filtered by `?status=`) for the Releases workbench. POST
 * creates a new draft release AND its 1:1 label component row, so the Label
 * card never has to handle a missing row. Mirrors
 * `app/api/brand/labels/route.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  createRelease,
  listReleases,
  type BrandRelease,
  type SupabaseLikeClient,
} from "@/lib/brand/releases";
import { createLabel, type SupabaseLikeClient as LabelsClient } from "@/lib/brand/labels";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.brandReleasesRead); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const status = new URL(req.url).searchParams.get("status") as BrandRelease["status"] | null;
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const releases = await listReleases(supabase, status ? { status } : undefined);
    return NextResponse.json(releases);
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
    const body = (await req.json()) as { name?: string };
    if (!body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const release = await createRelease(admin as unknown as SupabaseLikeClient, { name: body.name });
    await createLabel(admin as unknown as LabelsClient, { release_id: release.id, name: body.name });
    return NextResponse.json(release, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
