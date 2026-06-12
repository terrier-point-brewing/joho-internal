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

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("brew_step_templates")
    .select("*, brew_step_template_steps(*)")
    .order("created_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(
    (data ?? []).map((t) => ({
      ...t,
      brew_step_template_steps: [...(t.brew_step_template_steps ?? [])].sort(
        (a: { sort_order: number }, b: { sort_order: number }) => a.sort_order - b.sort_order
      ),
    }))
  );
}

export async function POST(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const body = await req.json() as { name: string; description?: string; steps?: StepInput[] };
    const { name, description, steps = [] } = body;
    if (!name?.trim()) return NextResponse.json({ error: "Name required" }, { status: 400 });

    const { data: tmpl, error: tErr } = await supabase
      .from("brew_step_templates")
      .insert({ name: name.trim(), description: description?.trim() || null })
      .select()
      .single();
    if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

    if (steps.length > 0) {
      const { error: sErr } = await supabase
        .from("brew_step_template_steps")
        .insert(steps.map((s, i) => parseStep(s, i, tmpl.id)));
      if (sErr) return NextResponse.json({ error: sErr.message }, { status: 500 });
    }

    return NextResponse.json(tmpl, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
