/**
 * Single brand release — admin-gated read, update, release/archive. GET
 * returns the row; PATCH with `{action:"release"|"archive"}` flips status,
 * otherwise the body is applied as a field patch via `updateRelease`.
 * Mirrors `app/api/brand/labels/[id]/route.ts`.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  archiveRelease,
  getRelease,
  markReleased,
  updateRelease,
  type SupabaseLikeClient,
} from "@/lib/brand/releases";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandReleasesRead); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const release = await getRelease(supabase, id);
    if (!release) {
      return NextResponse.json({ error: "Release not found" }, { status: 404 });
    }
    return NextResponse.json(release);
  } catch (err) {
    return apiError(err);
  }
}

export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandReleasesManage); // admin only
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as { action?: string; [key: string]: unknown };
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;

    if (body.action === "release") {
      await markReleased(supabase, id);
    } else if (body.action === "archive") {
      await archiveRelease(supabase, id);
    } else {
      const { action: _action, ...patch } = body;
      await updateRelease(supabase, id, patch);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
