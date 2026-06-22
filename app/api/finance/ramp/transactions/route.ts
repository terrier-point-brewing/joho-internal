import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampTransactions } from "@/lib/ramp";
import { apiError } from "@/lib/utils/api";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }

  const { searchParams } = req.nextUrl;
  const from = searchParams.get("from") ?? undefined;
  const to   = searchParams.get("to")   ?? undefined;

  try {
    const transactions = await getRampTransactions(from, to);
    return NextResponse.json(transactions);
  } catch (err) {
    return apiError(err);
  }
}
