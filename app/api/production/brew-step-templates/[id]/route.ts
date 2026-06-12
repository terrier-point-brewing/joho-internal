import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

interface StepInput {
  activity: string;
  time_label?: string | null;
  temp?: string | number | null;
  temp_unit?: string;
  amount?: string | number | null;
  amount_unit?: string | null;
  vsp?: string | number | null;
}

function parseStep(s: StepInput, i: number, templateId: string) {
  return {
    template_id: templateId,
    sort_order: i,
    activity: s.activity,
    time_label: s.time_label || null,
    temp:        s.temp   != null && s.temp   !== "" ? Number(s.temp)   : null,
    temp_unit:   s.temp_unit || "F",
    amount:      s.amount != null && s.amount !== "" ? Number(s.amount) : null,
    amount_unit: s.amount_unit || null,
    vsp:         s.vsp    != null && s.vsp    !== "" ? Number(s.vsp)    : null,
  };
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  try {
    const { id } = await params;
    const { name, description, steps } = await req.json() as {
      name?: string;
      description?: string;
      steps?: StepInput[];
    };

    if (name !== undefined) {
      const { error } = await supabase
        .from("brew_step_templates")
        .update({ name: name.trim(), description: description?.trim() || null })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (steps !== undefined) {
      await supabase.from("brew_step_template_steps").delete().eq("template_id", id);
      if (steps.length > 0) {
        const { error: sErr } = await supabase
          .from("brew_step_template_steps")
          .insert(steps.map((s, i) => parseStep(s, i, id)));
        if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();
  const { id } = await params;
  const { error } = await supabase.from("brew_step_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
