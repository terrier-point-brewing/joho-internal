import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, SCOPES, RANK, ROOT, can } from "@/lib/auth";
import type { Level } from "@/lib/auth";
import { invalidateRoleBundles } from "@/lib/auth/roleBundles.server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

const VALID_KEYS = new Set<string>([
  ROOT,
  ...Object.keys(SCOPES),
  ...Object.values(SCOPES).map((s) => s.section),
]);
const VALID_LEVELS = new Set(Object.keys(RANK));

/**
 * Only the three subordinate presets are editable.
 *
 * `admin` is immutable because it is the recovery path: an admin who removes
 * ROOT from their own bundle locks every admin out of the app with no way back
 * except raw SQL. `custom` is per-user by definition — its grants live in
 * user_permission_grants and are edited through the per-user matrix.
 */
const EDITABLE_ROLES = new Set(["viewer", "brewer", "manager"]);

export async function GET(_req: NextRequest, { params }: { params: Promise<{ role: string }> }) {
  try {
    await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { role } = await params;
  const { data, error } = await createSupabaseAdminClient()
    .from("role_permission_grants")
    .select("scope, level")
    .eq("role", role);

  if (error) return apiError(error);

  const grants: Record<string, Level> = Object.fromEntries(
    (data ?? []).map((r: { scope: string; level: string }) => [r.scope, r.level as Level]),
  );
  return NextResponse.json({ grants, editable: EDITABLE_ROLES.has(role) });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ role: string }> }) {
  let session;
  try {
    session = await requirePermission(CAP.usersManage);
  } catch (res) {
    return res as Response;
  }

  const { role } = await params;
  if (!EDITABLE_ROLES.has(role)) {
    return apiError(`The ${role} bundle cannot be edited here`, 403);
  }

  const body = await req.json().catch(() => null);
  const grants = body?.grants as Record<string, Level> | undefined;
  if (!grants || typeof grants !== "object") {
    return apiError("grants object is required", 400);
  }

  for (const [scope, level] of Object.entries(grants)) {
    if (!VALID_KEYS.has(scope)) return apiError(`Unknown scope: ${scope}`, 400);
    if (!VALID_LEVELS.has(level)) return apiError(`Unknown level: ${level}`, 400);
  }

  // Lockout guard. Editing your OWN role's bundle can revoke the very
  // permission that lets you edit bundles, and the admin bundle is immutable
  // above precisely so a recovery path always exists — this closes the other
  // door, where an admin has been demoted to an editable preset.
  if (session.role === role && !can(grants, CAP.usersManage.scope, CAP.usersManage.level)) {
    return apiError(
      "That change would remove your own ability to manage users. Ask another admin, or make the change from an admin account.",
      409,
    );
  }

  const admin = createSupabaseAdminClient();

  // Replace wholesale, same as the per-user matrix: the table is small and a
  // diff would have to reason about removals anyway.
  const { error: delError } = await admin.from("role_permission_grants").delete().eq("role", role);
  if (delError) return apiError(delError);

  const rows = Object.entries(grants).map(([scope, level]) => ({
    role,
    scope,
    level,
    updated_by: session.user.id,
  }));

  if (rows.length > 0) {
    const { error: insError } = await admin.from("role_permission_grants").insert(rows);
    if (insError) return apiError(insError);
  }

  // Clears this instance immediately; others expire on the cache TTL.
  invalidateRoleBundles();

  return NextResponse.json({ ok: true });
}
