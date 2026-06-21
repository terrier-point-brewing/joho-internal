import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase
    .from("export_transactions")
    .select("*, brew_batches(id, beer_name, batch_number)")
    .order("created_at", { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

// All exports must go through /api/production/cold-storage-export to enforce
// FIFO inventory checks. Direct inserts to export_transactions are blocked here.
export async function POST() {
  return NextResponse.json(
    { error: "Use /api/production/cold-storage-export to record exports" },
    { status: 405 }
  );
}
