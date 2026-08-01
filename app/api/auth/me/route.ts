import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { toAuthMe } from "@/lib/auth/me";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(toAuthMe(await getSessionUser()));
}
