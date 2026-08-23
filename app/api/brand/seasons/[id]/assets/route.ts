/**
 * A season's asset kit — the motifs, examples and textures that furnish it.
 *
 * `brand_season_assets` is service-role-only by design: RLS is on with zero
 * policies, matching every other brand_* table (20261003090003), and a CHILD
 * table readable over the Data API while its parent is not would be incoherent.
 * So every read and write goes through `createSupabaseAdminClient()` behind
 * `requirePermission`, exactly as the season routes beside it already do. The
 * gate on this data is this route's.
 *
 * Gated on `brand.templates`, like the season itself: furnishing a season is the
 * same job as authoring it, and it is the single grant a hired seasonal designer
 * would hold.
 *
 * Reads live on GET /api/brand/seasons, which returns each season with its kit
 * — the board renders whole panels, so it wants every kit at once.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  addSeasonAsset,
  moveSeasonAsset,
  removeSeasonAsset,
  setSeasonAssetNote,
  setSeasonAssetRole,
  SEASON_ASSET_ROLES,
  type SeasonAssetClient,
  type SeasonAssetRole,
} from "@/lib/brand/seasons";

export const dynamic = "force-dynamic";

/** A role the table's CHECK will accept, or a 400-worthy message. */
function readRole(value: unknown, field: string): SeasonAssetRole {
  if (typeof value === "string" && (SEASON_ASSET_ROLES as readonly string[]).includes(value)) {
    return value as SeasonAssetRole;
  }
  throw new Error(`${field} must be one of ${SEASON_ASSET_ROLES.join(", ")}.`);
}

function readAssetId(value: unknown): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error("asset_id is required.");
}

/** Shared by all three verbs: a caller error is theirs, a storage error is ours. */
function respond(err: unknown) {
  if (err instanceof Error && !/^Failed/.test(err.message)) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  return apiError(err);
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandTemplatesManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = createSupabaseAdminClient() as unknown as SeasonAssetClient;

    await addSeasonAsset(client, {
      season_id: id,
      asset_id: readAssetId(body.asset_id),
      role: readRole(body.role, "role"),
      note: typeof body.note === "string" ? body.note : null,
    });
    return NextResponse.json({ ok: true }, { status: 201 });
  } catch (err) {
    return respond(err);
  }
}

/**
 * Reorder, re-role, or annotate one row, addressed by its full key.
 *
 * One verb rather than three routes because all three are the same edit to the
 * same membership row, and which one is meant is unambiguous from the body.
 */
export async function PATCH(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandTemplatesManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const client = createSupabaseAdminClient() as unknown as SeasonAssetClient;
    const key = {
      season_id: id,
      asset_id: readAssetId(body.asset_id),
      role: readRole(body.role, "role"),
    };

    if (body.direction === "up" || body.direction === "down") {
      await moveSeasonAsset(client, key, body.direction);
    } else if ("to_role" in body) {
      await setSeasonAssetRole(client, key, readRole(body.to_role, "to_role"));
    } else if ("note" in body) {
      await setSeasonAssetNote(client, key, typeof body.note === "string" ? body.note : null);
    } else {
      return NextResponse.json(
        { error: "Nothing to change: send a direction, a to_role, or a note." },
        { status: 400 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return respond(err);
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.brandTemplatesManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    // Key in the query string: a DELETE body is not reliably readable, and the
    // row's identity is three columns rather than a path-shaped id.
    const params = new URL(req.url).searchParams;
    const client = createSupabaseAdminClient() as unknown as SeasonAssetClient;

    await removeSeasonAsset(client, {
      season_id: id,
      asset_id: readAssetId(params.get("asset_id")),
      role: readRole(params.get("role"), "role"),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return respond(err);
  }
}
