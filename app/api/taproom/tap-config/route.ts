import { NextRequest, NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createSupabaseServerClient();
  const [settingsRes, tapsRes] = await Promise.all([
    supabase.from("system_settings").select("value").eq("key", "tap_count").maybeSingle(),
    supabase
      .from("tap_assignments")
      .select("tap_number, recipe_id, label, recipes(beer_name)")
      .order("tap_number"),
  ]);
  return NextResponse.json({
    tap_count: Number(settingsRes.data?.value ?? 8),
    taps: tapsRes.data ?? [],
  });
}

export async function PUT(req: NextRequest) {
  const supabase = await createSupabaseServerClient();
  try {
    const body = await req.json() as {
      tap_count?: number;
      taps?: { tap_number: number; recipe_id: string | null; label?: string }[];
    };
    const { tap_count, taps } = body;

    if (tap_count !== undefined) {
      await supabase
        .from("system_settings")
        .upsert(
          { key: "tap_count", value: tap_count, updated_at: new Date().toISOString() },
          { onConflict: "key" }
        );
    }

    if (taps !== undefined) {
      for (const tap of taps) {
        await supabase
          .from("tap_assignments")
          .upsert(
            {
              tap_number: tap.tap_number,
              recipe_id:  tap.recipe_id || null,
              label:      tap.label || null,
              updated_at: new Date().toISOString(),
            },
            { onConflict: "tap_number" }
          );
      }
      // Remove any tap numbers that exceed the new count
      const effectiveCount = tap_count ?? 999;
      await supabase.from("tap_assignments").delete().gt("tap_number", effectiveCount);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return apiError(err);
  }
}
