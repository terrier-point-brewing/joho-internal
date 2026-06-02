import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET() {
  const { data, error } = await supabase
    .from("workflow_templates")
    .select("*, workflow_template_steps(*, equipment(id,name,type))")
    .order("name");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const { name, description, steps } = await req.json();

  const { data: tmpl, error: tmplErr } = await supabase
    .from("workflow_templates")
    .insert({ name, description: description || null })
    .select()
    .single();

  if (tmplErr) return NextResponse.json({ error: tmplErr.message }, { status: 500 });

  if (steps?.length) {
    const rows = steps.map((s: { equipment_id: string; duration_days?: number; notes?: string }, i: number) => ({
      template_id: tmpl.id,
      step_order: i + 1,
      equipment_id: s.equipment_id,
      duration_days: s.duration_days ?? null,
      notes: s.notes || null,
    }));
    const { error } = await supabase.from("workflow_template_steps").insert(rows);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("workflow_templates")
    .select("*, workflow_template_steps(*, equipment(id,name,type))")
    .eq("id", tmpl.id)
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
