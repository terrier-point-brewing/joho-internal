import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { loadIntakeDemand } from "@/lib/production/intakeDemand.server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  try {
    const { rows, warnings } = await loadIntakeDemand(supabase);
    return NextResponse.json({ rows, warnings });
  } catch (err) {
    return apiError(err);
  }
}
