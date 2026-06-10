import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// PATCH releases a tank assignment (sets released_at = now)
export async function PATCH(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requireRole("brewer"); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  const { data, error } = await supabase
    .from("batch_tank_assignments")
    .update({ released_at: new Date().toISOString() })
    .eq("id", id)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
