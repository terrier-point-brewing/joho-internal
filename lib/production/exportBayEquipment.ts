import { SupabaseClient } from "@supabase/supabase-js";

/**
 * Looks up the single `equipment` row of type "export_bay" that all export
 * transfers write to. Returns null (not a thrown error) when none is
 * configured, so callers can fail loudly with their own 500 response —
 * staying consistent with checkAndCompleteBatch/computeExciseTaxBreakdown's
 * existing style of returning plain data, not NextResponse objects.
 */
export async function getExportBayEquipmentId(supabase: SupabaseClient): Promise<string | null> {
  const { data, error } = await supabase
    .from("equipment")
    .select("id")
    .eq("type", "export_bay")
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data?.id ?? null;
}
