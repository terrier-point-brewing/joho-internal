import { NextRequest, NextResponse } from "next/server";
import { supabase } from "@/lib/supabase/client";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();

  // Special: marking complete sets completed_at to now
  if (body.complete === true) {
    body.completed_at = new Date().toISOString();
    delete body.complete;
  } else if (body.complete === false) {
    body.completed_at = null;
    delete body.complete;
  }

  const { data, error } = await supabase
    .from("batch_workflow_steps")
    .update(body)
    .eq("id", id)
    .select("*, tanks(id,name,type)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const { error } = await supabase.from("batch_workflow_steps").delete().eq("id", id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
