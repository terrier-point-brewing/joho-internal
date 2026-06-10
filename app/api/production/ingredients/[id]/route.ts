import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();

  const { id } = await params;
  const body = await req.json();

  const { data, error } = await supabase
    .from("ingredients")
    .update(body)
    .eq("id", id)
    .select("*, suppliers(company_name), contract_brewing_partners(company_name)")
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createSupabaseServerClient();

  const { id } = await params;

  // Guard: block deletion if the ingredient is used in any recipe
  const { data: usages, error: usageErr } = await supabase
    .from("recipe_ingredients")
    .select("recipe_id, recipes(beer_name)")
    .eq("ingredient_id", id);

  if (usageErr) return NextResponse.json({ error: usageErr.message }, { status: 500 });

  if (usages && usages.length > 0) {
    const recipeNames = (usages as unknown as { recipes: { beer_name: string } | null }[])
      .map((u) => u.recipes?.beer_name)
      .filter(Boolean)
      .join(", ");
    return NextResponse.json(
      { error: `Ingredient is used in recipe${usages.length > 1 ? "s" : ""}: ${recipeNames}. Remove it from those recipes before deleting.` },
      { status: 409 }
    );
  }

  const { error } = await supabase
    .from("ingredients")
    .delete()
    .eq("id", id);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return new NextResponse(null, { status: 204 });
}
