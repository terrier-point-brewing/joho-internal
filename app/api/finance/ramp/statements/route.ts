import { NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getRampStatements } from "@/lib/ramp";
import { apiError } from "@/lib/utils/api";

export async function GET() {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  try {
    const statements = await getRampStatements();
    return NextResponse.json(statements);
  } catch (err) {
    return apiError(err);
  }
}
