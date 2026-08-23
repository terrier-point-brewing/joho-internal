/**
 * Brand seasons — list + create. A season is what every `motif` slot resolves
 * against, so this is the rotation control for the whole template system.
 *
 * Gated on `brand.templates` rather than a scope of its own: authoring a season
 * is the same kind of structural act as authoring a template, and splitting them
 * would mean two grants for one job.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  createSeason,
  listSeasonKits,
  listSeasons,
  type SeasonAssetClient,
  type SupabaseLikeClient,
} from "@/lib/brand/seasons";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requirePermission(CAP.brandTemplatesRead);
  } catch (res) {
    return res as Response;
  }

  try {
    const admin = createSupabaseAdminClient();

    // Each season carries its own kit rows. `brand_season_assets` is
    // service-role-only with RLS on and zero policies — the posture every other
    // brand_* table has — so this route is the only way to read it, and the
    // board is a per-season panel, so the kit belongs in the season's payload
    // rather than behind a second round trip per panel.
    const [seasons, kits] = await Promise.all([
      listSeasons(admin as unknown as SupabaseLikeClient),
      listSeasonKits(admin as unknown as SeasonAssetClient),
    ]);

    return NextResponse.json(
      seasons.map((season) => ({ ...season, kit: kits.get(season.id) ?? [] })),
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
    if (!body.name) {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient() as unknown as SupabaseLikeClient;
    const season = await createSeason(supabase, {
      name: String(body.name),
      background_hex: (body.background_hex as string) ?? null,
      chop_glyph_asset_id: (body.chop_glyph_asset_id as string) ?? null,
      cultural_lean: (body.cultural_lean as string) ?? null,
      starts_at: (body.starts_at as string) ?? null,
      ends_at: (body.ends_at as string) ?? null,
    });
    return NextResponse.json(season, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
