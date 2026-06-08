import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampTransactions } from "@/lib/ramp";

export async function GET(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from") ?? undefined;
  const to   = searchParams.get("to")   ?? undefined;

  try {
    const transactions = await getRampTransactions(from, to);
    return NextResponse.json(transactions);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
