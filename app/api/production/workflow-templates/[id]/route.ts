import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { name, description, steps } = await req.json();

  const { error: tmplErr } = await supabase
    .from("workflow_templates")
    .update({ name, description: description || null })
    .eq("id", id);
  if (tmplErr) return NextResponse.json({ error: tmplErr.message }, { status: 500 });

  if (steps !== undefined) {
    await supabase.from("workflow_template_steps").delete().eq("template_id", id);
    if (steps.length) {
      const rows = steps.map((s: { equipment_id: string; duration_days?: number; notes?: string }, i: number) => ({
        template_id: id,
        step_order: i + 1,
        equipment_id: s.equipment_id,
        duration_days: s.duration_days ?? null,
        notes: s.notes || null,
      }));
      const { error } = await supabase.from("workflow_template_steps").insert(rows);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
  }

  const { data, error } = await supabase
    .from("workflow_templates")
    .select("*, workflow_template_steps(*, tanks(id,name,type))")
    .eq("id", id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase.from("workflow_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
