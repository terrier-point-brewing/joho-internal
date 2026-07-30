import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  getDraft,
  saveDraft,
  saveDraftSection,
  type SupabaseLikeClient,
} from "@/lib/brand/canonWorkflow";
import { guideSectionSchema } from "@/lib/brand/canon.schema";

export const dynamic = "force-dynamic";

// Canon editing is admin-only — the draft is the working copy behind the
// published guide/tokens, so reads and writes both require CAP.brandGuideManage.
export async function GET() {
  try {
    await requirePermission(CAP.brandGuideManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const draft = await getDraft(supabase);
    return NextResponse.json(draft);
  } catch (err) {
    return apiError(err);
  }
}

// Whole-document save. Retained as an escape hatch; the editor uses PATCH.
export async function PUT(req: NextRequest) {
  try {
    await requirePermission(CAP.brandGuideManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = await req.json();
    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    await saveDraft(supabase, body);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

/**
 * Section-scoped save — the path the Brand Guide editor actually uses.
 *
 * Body: `{ section, patch }`. Only the canon keys that subtab owns are
 * validated and written, so an invalid field on another subtab can't block this
 * one. The client never sends a full document, which also means two admins on
 * different subtabs don't clobber each other.
 */
export async function PATCH(req: NextRequest) {
  try {
    await requirePermission(CAP.brandGuideManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json()) as { section?: unknown; patch?: unknown };

    const section = guideSectionSchema.safeParse(body.section);
    if (!section.success) {
      return NextResponse.json(
        { error: `section must be one of: ${guideSectionSchema.options.join(", ")}` },
        { status: 400 },
      );
    }
    if (typeof body.patch !== "object" || body.patch === null || Array.isArray(body.patch)) {
      return NextResponse.json({ error: "patch must be an object" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    await saveDraftSection(supabase, section.data, body.patch);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
