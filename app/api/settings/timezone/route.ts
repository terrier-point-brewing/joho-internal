import { NextRequest, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { getSessionUser, requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  BREWERY_TIMEZONE_KEY,
  BREWERY_TIMEZONE_TAG,
  SUPPORTED_TIMEZONES,
  isSupportedTimezone,
  timezoneLabel,
} from "@/lib/settings/breweryTimezone";
import { getBreweryTimezone } from "@/lib/settings/breweryTimezone.server";

export const dynamic = "force-dynamic";

// Any authenticated user can read the active zone — reporting pages need it to
// label and lay out dates. Returns the current value plus the option list so the
// settings picker and the label component share one source.
export async function GET() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const timezone = await getBreweryTimezone();
  return NextResponse.json({
    timezone,
    label: timezoneLabel(timezone),
    options: SUPPORTED_TIMEZONES,
  });
}

// Changing the brewery zone shifts every day-bucketed metric, so it's admin-only.
export async function PUT(req: NextRequest) {
  try {
    await requirePermission(CAP.businessSettingsManage); // admin only
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json()) as { timezone?: unknown };
    if (!isSupportedTimezone(body.timezone)) {
      return NextResponse.json({ error: "Unsupported timezone" }, { status: 400 });
    }

    const supabase = createSupabaseAdminClient();
    const { error } = await supabase
      .from("system_settings")
      .upsert(
        { key: BREWERY_TIMEZONE_KEY, value: body.timezone },
        { onConflict: "key" },
      );
    if (error) throw error;

    // Refresh the cached zone and any sales data bucketed with the old one.
    // "max" = stale-while-revalidate (the recommended, non-deprecated form).
    revalidateTag(BREWERY_TIMEZONE_TAG, "max");
    revalidateTag("square-sales", "max");

    return NextResponse.json({
      timezone: body.timezone,
      label: timezoneLabel(body.timezone),
    });
  } catch (err) {
    return apiError(err);
  }
}
