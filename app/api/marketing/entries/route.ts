/**
 * The calendar's read and write surface.
 *
 * `GET  ?from=&to=`  — every entry starting in the half-open window `[from,to)`,
 *                      each with its media in the caller's order and its
 *                      deliveries. One round trip's worth: a month grid and an
 *                      entry detail pane are both drawn from this.
 * `POST`             — one entry, its ordered media, and (only when a person
 *                      says "post now") its deliveries plus an inline publish.
 *
 * Thin on purpose. Every rule — which statuses app code may write, that a
 * future `scheduled_at` is unreachable, what "post now" does — lives in
 * lib/marketing/entries.ts with its tests, and this file turns a refusal into a
 * status code.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { createEntry, listEntries, parseCreateEntry, parseEntryWindow } from "@/lib/marketing/entries";
import { MarketingRequestError } from "@/lib/marketing/errors";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    await requirePermission(CAP.marketingCalendarRead);
  } catch (res) {
    return res as Response;
  }

  try {
    const params = new URL(req.url).searchParams;
    const window = parseEntryWindow(params.get("from"), params.get("to"));
    const entries = await listEntries(createSupabaseAdminClient(), window);
    return NextResponse.json(entries);
  } catch (err) {
    if (err instanceof MarketingRequestError) return apiError(err.message, err.status);
    return apiError(err);
  }
}

export async function POST(req: NextRequest) {
  // `operate` on the calendar, not `publish`: this is deciding WHAT goes out.
  // The one path here that actually publishes is "post now", which is a person
  // pressing a button on an entry they are creating in the same breath.
  let session;
  try {
    session = await requirePermission(CAP.marketingCalendarEdit);
  } catch (res) {
    return res as Response;
  }

  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json({ error: "Expected a JSON body." }, { status: 400 });
    }

    const input = parseCreateEntry(raw);
    const entry = await createEntry(createSupabaseAdminClient(), input, {
      createdBy: session.user.id,
    });
    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    if (err instanceof MarketingRequestError) return apiError(err.message, err.status);
    return apiError(err);
  }
}
