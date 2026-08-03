/**
 * Single brand release — admin-gated read, update, publish/archive. GET
 * returns the row; PATCH with `{action:"release"|"archive"}` flips status,
 * otherwise the body is applied as a field patch via `updateRelease`.
 * Mirrors `app/api/brand/labels/[id]/route.ts`.
 *
 * Publishing is GATED here, not only in the UI: the workbench disables its
 * button when a component is outstanding, but a tab left open across an edit,
 * or a direct call, would otherwise still publish a half-built release. The
 * gate reads the same pure `releaseReadiness` the button does, so the two can
 * never disagree about what "ready" means.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { getLabelByRelease, type SupabaseLikeClient as LabelClient } from "@/lib/brand/labels";
import {
  archiveRelease,
  getRelease,
  markReleased,
  releaseReadiness,
  updateRelease,
  type BrandRelease,
  type ReleaseContainer,
  type RecipeFacts,
  type SupabaseLikeClient,
} from "@/lib/brand/releases";

/**
 * The four tables the publish gate spans. The workbench gathers these from its
 * own hooks; server-side they're four reads, run together.
 *
 * The container select carries the explicit FK-constraint hint on purpose:
 * `packaging_variations` has five FKs to `packaging_items`, so a bare
 * `container_id` target is ambiguous and silently leaves `container` null —
 * which would read as "no can variation" for every release. Same reason
 * PACKAGING_VARIATION_SELECT spells it out; this is the two-column version.
 */
async function gatherReadiness(release: BrandRelease) {
  const supabase = createSupabaseAdminClient();
  const [recipeRes, containerRes, label] = await Promise.all([
    release.recipe_id
      ? supabase.from("recipes").select("style, abv").eq("id", release.recipe_id).limit(1)
      : Promise.resolve({ data: [] }),
    release.recipe_id
      ? supabase
          .from("recipe_packaging_variations")
          .select(
            `product_code,
             packaging_variations!inner(
               is_active,
               container:packaging_items!packaging_variations_container_id_fkey(type)
             )`,
          )
          .eq("recipe_id", release.recipe_id)
          .eq("packaging_variations.is_active", true)
      : Promise.resolve({ data: [] }),
    getLabelByRelease(supabase as unknown as LabelClient, release.id),
  ]);

  return {
    release,
    recipe: ((recipeRes.data ?? [])[0] ?? null) as RecipeFacts | null,
    containers: ((containerRes.data ?? []) as unknown as ReleaseContainer[]),
    label,
  };
}

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
      const release = await getRelease(supabase, id);
      if (!release) {
        return NextResponse.json({ error: "Release not found" }, { status: 404 });
      }
      const { ready, outstanding } = releaseReadiness(await gatherReadiness(release));
      if (!ready) {
        return NextResponse.json(
          { error: `Not every component is ready — outstanding: ${outstanding.join(", ")}` },
          { status: 409 },
        );
      }
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
