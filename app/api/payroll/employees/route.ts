import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("employees")
    .select("*")
    .order("last_name");

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const body = await req.json();

  const { data, error } = await supabase
    .from("employees")
    .insert(body)
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data, { status: 201 });
}
