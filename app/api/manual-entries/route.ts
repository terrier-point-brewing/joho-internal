import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("manual_net_sales_entries")
      .select("id, start_date, end_date, amount_cents, label")
      .order("start_date", { ascending: false });
    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { start_date, end_date, amount_cents, label } = await req.json();
    if (!start_date || !end_date || amount_cents == null) {
      return NextResponse.json(
        { error: "start_date, end_date, amount_cents required" },
        { status: 400 }
      );
    }
    if (start_date > end_date) {
      return NextResponse.json(
        { error: "start_date must be on or before end_date" },
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("manual_net_sales_entries")
      .insert({ start_date, end_date, amount_cents, label: label ?? null })
      .select()
      .single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const { id } = await req.json();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
    const { error } = await supabase
      .from("manual_net_sales_entries")
      .delete()
      .eq("id", id);
    if (error) throw error;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
