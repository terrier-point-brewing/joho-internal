/**
 * Brand templates — list + create. GET filters by `?medium=` / `?status=`;
 * POST creates a draft at version 1. Mirrors `app/api/brand/labels/route.ts`.
 *
 * Reads take `brand.templates:read`, writes `manage`. Authoring a template is
 * deliberately a different grant from producing outputs with one: someone who
 * lays out a hundred labels should not thereby be able to change the chassis
 * every label is built on.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  createTemplate,
  listTemplates,
  type BrandTemplate,
  type SupabaseLikeClient,
  type TemplateMedium,
} from "@/lib/brand/templates";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.brandTemplatesRead);
  } catch (res) {
    return res as Response;
  }

  try {
    const params = new URL(req.url).searchParams;
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    return NextResponse.json(
      await listTemplates(supabase, {
        medium: (params.get("medium") as TemplateMedium) ?? undefined,
        status: (params.get("status") as BrandTemplate["status"]) ?? undefined,
      }),
    );
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    await requirePermission(CAP.brandTemplatesManage);
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    if (!body.key || !body.name || !body.medium) {
      return NextResponse.json({ error: "key, name and medium are required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    // createTemplate validates slots and renditions and throws with the list of
    // problems; a 400 is right because the caller can fix them.
    const template = await createTemplate(supabase, {
      key: String(body.key),
      name: String(body.name),
      medium: body.medium as TemplateMedium,
      slots: body.slots as never,
      renditions: body.renditions as never,
      constraints: body.constraints as Record<string, unknown>,
      base_svg_path: (body.base_svg_path as string) ?? null,
      notes: (body.notes as string) ?? null,
    });
    return NextResponse.json(template, { status: 201 });
  } catch (err) {
    if (err instanceof Error && !/^Failed/.test(err.message)) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    return apiError(err);
  }
}
