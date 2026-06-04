import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";
import { apiError } from "@/lib/utils/api";

export async function GET() {
  try {
    const { data, error } = await supabase
      .from("manual_net_sales_entries")
      .select("id, year, month, amount_cents, label")
      .order("year",  { ascending: false })
      .order("month", { ascending: false });
    if (error) throw error;
    return NextResponse.json(data);
  } catch (err) {
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { year, month, amount_cents, label } = await req.json();
    if (!year || !month || amount_cents == null) {
      return NextResponse.json(
        { error: "year, month, amount_cents required" },
        { status: 400 }
      );
    }
    const { data, error } = await supabase
      .from("manual_net_sales_entries")
      .upsert({ year, month, amount_cents, label: label ?? null }, { onConflict: "year,month" })
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
