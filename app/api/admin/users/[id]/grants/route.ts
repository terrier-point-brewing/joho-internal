import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, SCOPES, RANK, ROOT } from "@/lib/auth";
import type { Level } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

// Any key a custom user's grants may legally carry: every leaf ScopeKey,
// every Section (a collapsed-row grant), or ROOT (admin-everywhere).
const VALID_KEYS = new Set<string>([
  ROOT,
  ...Object.keys(SCOPES),
  ...Object.values(SCOPES).map((s) => s.section),
]);
const VALID_LEVELS = new Set(Object.keys(RANK));

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("user_permission_grants")
    .select("scope, level")
    .eq("user_id", id);

  if (error) return apiError(error);

  const grants: Record<string, Level> = Object.fromEntries(
    (data ?? []).map((r: { scope: string; level: string }) => [r.scope, r.level as Level]),
  );
  return NextResponse.json({ grants });
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  let session;
  try {
    session = await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const grants = body?.grants as Record<string, Level> | undefined;

  if (!grants || typeof grants !== "object") {
    return apiError("grants object is required", 400);
  }

  for (const [scope, level] of Object.entries(grants)) {
    if (!VALID_KEYS.has(scope)) return apiError(`Unknown scope: ${scope}`, 400);
    if (!VALID_LEVELS.has(level)) return apiError(`Unknown level: ${level}`, 400);
  }

  const admin = createSupabaseAdminClient();

  // Replace wholesale — simpler and safer than diffing, and this table is
  // small per-user (≤ 20 leaves + 7 sections).
  const { error: delError } = await admin
    .from("user_permission_grants")
    .delete()
    .eq("user_id", id);
  if (delError) return apiError(delError);

  const rows = Object.entries(grants).map(([scope, level]) => ({
    user_id: id,
    scope,
    level,
    granted_by: session.user.id,
  }));

  if (rows.length > 0) {
    const { error: insError } = await admin.from("user_permission_grants").insert(rows);
    if (insError) return apiError(insError);
  }

  return NextResponse.json({ ok: true });
}
