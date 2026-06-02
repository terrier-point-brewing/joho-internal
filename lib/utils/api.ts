import { NextRequest, NextResponse } from "next/server";

export function requireDateRange(req: NextRequest): { start: string; end: string } | NextResponse {
  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end   = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });
  return { start, end };
}

export function apiError(err: unknown): NextResponse {
  const msg = err instanceof Error ? err.message : "Unknown error";
  return NextResponse.json({ error: msg }, { status: 500 });
}
