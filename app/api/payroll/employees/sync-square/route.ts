import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { fetchActiveTeamMembers } from "@/lib/square/teamMembers";

export const dynamic = "force-dynamic";

export async function POST() {
  try { await requireRole([]); } catch (res) { return res as Response; }

  let members;
  try {
    members = await fetchActiveTeamMembers();
  } catch (err) {
    return apiError(err instanceof Error ? err.message : "Square fetch failed");
  }

  if (members.length === 0) {
    return NextResponse.json({ created: 0, updated: 0 });
  }

  const supabase = await createSupabaseServerClient();

  // Fetch existing employees by square_team_member_id to determine create vs update paths.
  const ids = members.map(m => m.id);
  const { data: existing, error: existingErr } = await supabase
    .from("employees")
    .select("square_team_member_id")
    .in("square_team_member_id", ids);

  if (existingErr) return apiError(existingErr.message);

  const existingIds = new Set((existing ?? []).map((e: { square_team_member_id: string }) => e.square_team_member_id));

  const newMembers = members.filter(m => !existingIds.has(m.id));
  const existingMembers = members.filter(m => existingIds.has(m.id));

  // INSERT new employees with full defaults — admin can edit these fields after sync.
  if (newMembers.length > 0) {
    const newRows = newMembers.map(m => ({
      first_name:            m.given_name,
      last_name:             m.family_name,
      email:                 m.email_address ?? "",
      square_team_member_id: m.id,
      job_title:             "Bartender" as const,
      employment_type:       "hourly" as const,
      receives_tips:         true,
      active:                true,
    }));

    const { error: insertErr } = await supabase.from("employees").insert(newRows);
    if (insertErr) return apiError(insertErr.message);
  }

  // UPDATE existing employees: only overwrite name + email; preserve all admin-edited fields
  // (job_title, employment_type, receives_tips, active, etc.).
  // Single upsert — no N+1 loop.
  if (existingMembers.length > 0) {
    const existingRows = existingMembers.map(m => ({
      square_team_member_id: m.id,
      first_name:            m.given_name,
      last_name:             m.family_name,
      email:                 m.email_address ?? "",
    }));

    const { error: updateErr } = await supabase
      .from("employees")
      .upsert(existingRows, { onConflict: "square_team_member_id" });

    if (updateErr) return apiError(updateErr.message);
  }

  return NextResponse.json({ created: newMembers.length, updated: existingMembers.length });
}
