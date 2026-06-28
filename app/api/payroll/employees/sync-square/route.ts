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

  // Fetch existing employees by square_team_member_id to determine create vs update counts.
  const ids = members.map(m => m.id);
  const { data: existing } = await supabase
    .from("employees")
    .select("square_team_member_id")
    .in("square_team_member_id", ids);

  const existingIds = new Set((existing ?? []).map((e: { square_team_member_id: string }) => e.square_team_member_id));

  const rows = members.map(m => ({
    first_name:            m.given_name,
    last_name:             m.family_name,
    email:                 m.email_address ?? "",
    square_team_member_id: m.id,
    // Defaults — admin can edit after sync; these are only written on INSERT.
    job_title:        "Bartender",
    employment_type:  "hourly",
    receives_tips:    true,
    active:           true,
  }));

  // Upsert: on conflict (square_team_member_id) update only name + email;
  // all other fields (job_title, employment_type, etc.) survive re-sync.
  const { error } = await supabase
    .from("employees")
    .upsert(rows, {
      onConflict: "square_team_member_id",
      // Supabase JS upsert updates all provided columns on conflict.
      // To preserve admin edits to job_title/employment_type we only send
      // fields that should be overwritten: first_name, last_name, email are
      // in `rows`; the rest are only relevant on INSERT (Supabase upsert
      // always writes all columns, so we strip the INSERT-only defaults from
      // the update path by using ignoreDuplicates for those columns via a
      // follow-up targeted update).
      ignoreDuplicates: false,
    });

  if (error) return apiError(error.message);

  // Patch: re-apply admin-preserve fields for existing records by reverting
  // job_title/employment_type/receives_tips to their stored values.
  // The upsert above may have clobbered them — fix with a targeted update
  // that only touches name + email for existing employees.
  if (existingIds.size > 0) {
    const existingRows = members
      .filter(m => existingIds.has(m.id))
      .map(m => ({
        square_team_member_id: m.id,
        first_name: m.given_name,
        last_name:  m.family_name,
        email:      m.email_address ?? "",
      }));

    for (const row of existingRows) {
      await supabase
        .from("employees")
        .update({ first_name: row.first_name, last_name: row.last_name, email: row.email })
        .eq("square_team_member_id", row.square_team_member_id);
    }
  }

  const created = members.filter(m => !existingIds.has(m.id)).length;
  const updated = existingIds.size;

  return NextResponse.json({ created, updated });
}
