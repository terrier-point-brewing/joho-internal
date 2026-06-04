import { NextRequest, NextResponse } from "next/server";
import { searchSquareCustomers } from "@/lib/square/customers";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("query") ?? "";
  try {
    const customers = await searchSquareCustomers(query || undefined);
    return NextResponse.json(customers);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Square API error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
