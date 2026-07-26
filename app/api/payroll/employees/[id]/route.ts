import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try { await requirePermission(CAP.payrollManage); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const body = await req.json();

  const { data, error } = await supabase
    .from("employees")
    .update(body)
    .eq("id", id)
    .select()
    .single();

  if (error) return apiError(error.message);
  return NextResponse.json(data);
}
