import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function GET(req: NextRequest) {
  const batchId = req.nextUrl.searchParams.get("batch_id");
  if (!batchId) return NextResponse.json({ error: "batch_id required" }, { status: 400 });

  const { data, error } = await supabase
    .from("batch_workflow_steps")
    .select("*, tanks(id,name,type)")
    .eq("batch_id", batchId)
    .order("step_order");

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Single step append
  if (body.step) {
    const { batch_id, step } = body;
    const { data: last } = await supabase
      .from("batch_workflow_steps")
      .select("step_order")
      .eq("batch_id", batch_id)
      .order("step_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextOrder = (last?.step_order ?? 0) + 1;

    const { data, error } = await supabase
      .from("batch_workflow_steps")
      .insert({
        batch_id,
        step_order: nextOrder,
        equipment_id: step.equipment_id,
        scheduled_date: step.scheduled_date || null,
        notes: step.notes || null,
      })
      .select("*, tanks(id,name,type)")
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  }

  // Apply template: bulk replace with date-calculated steps
  if (body.template_id) {
    const { batch_id, template_id, start_date } = body;

    const { data: tmplSteps } = await supabase
      .from("workflow_template_steps")
      .select("*")
      .eq("template_id", template_id)
      .order("step_order");

    if (!tmplSteps?.length) return NextResponse.json({ error: "No steps in template" }, { status: 400 });

    // Calculate dates from start_date + cumulative durations
    let currentDate = new Date(start_date);
    const rows = tmplSteps.map((s, i) => {
      const scheduled_date = currentDate.toISOString().slice(0, 10);
      if (s.duration_days) {
        currentDate = new Date(currentDate.getTime() + s.duration_days * 86400000);
      }
      return {
        batch_id,
        step_order: i + 1,
        equipment_id: s.equipment_id,
        scheduled_date,
        notes: s.notes || null,
      };
    });

    // Replace existing steps
    await supabase.from("batch_workflow_steps").delete().eq("batch_id", batch_id);
    const { data, error } = await supabase
      .from("batch_workflow_steps")
      .insert(rows)
      .select("*, tanks(id,name,type)");

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  }

  return NextResponse.json({ error: "Provide step or template_id" }, { status: 400 });
}
