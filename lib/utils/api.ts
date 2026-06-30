import { NextRequest, NextResponse } from "next/server";

export function requireDateRange(req: NextRequest): { start: string; end: string } | NextResponse {
  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end   = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
  return { start, end };
}

export function apiError(err: unknown, status = 500): NextResponse {
  const msg =
    typeof err === "string" ? err
    : err instanceof Error ? err.message
    // Non-Error objects (e.g. Supabase PostgrestError) carry a string `message`;
    // surface it instead of String(err) → "[object Object]".
    : err && typeof err === "object" && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
    : String(err);
  return NextResponse.json({ error: msg }, { status });
}
