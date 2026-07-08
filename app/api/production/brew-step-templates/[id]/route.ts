import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { parseActivityStep, type ActivityStepInput } from "@/lib/production/brewActivities";

export const dynamic = "force-dynamic";

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
      steps?: ActivityStepInput[];
    };

    if (name !== undefined) {
      const { error } = await supabase
        .from("brew_step_templates")
        .update({ name: name.trim(), description: description?.trim() || null })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }

    if (steps !== undefined) {
      await supabase.from("brew_activities").delete().eq("library_template_id", id);
      if (steps.length > 0) {
        const { error: sErr } = await supabase
          .from("brew_activities")
          .insert(steps.map((s, i) => ({ library_template_id: id, ...parseActivityStep(s, i) })));
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
  // brew_activities rows for this template drop via ON DELETE CASCADE.
  const { error } = await supabase.from("brew_step_templates").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
