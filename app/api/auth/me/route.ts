import { NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ user: null, role: null, grants: {} });
  return NextResponse.json({
    user: { id: session.user.id, email: session.user.email },
    role: session.role,
    grants: session.grants,
  });
}
