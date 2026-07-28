import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP, getSessionUser } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { getBrandChromeEnabled, setBrandChromeEnabled } from "@/lib/settings/brandChrome.server";

export const dynamic = "force-dynamic";

// The "apply brand to the internal app" toggle. Read is open to any signed-in
// user (the layout injects the skin for everyone); writing is admin-only.
export async function GET() {
  const session = await getSessionUser();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ enabled: await getBrandChromeEnabled() });
}

export async function PUT(req: NextRequest) {
  let session;
  try {
    await requirePermission(CAP.appearanceManage); // admin only
    session = await getSessionUser();
  } catch (res) {
    return res as Response;
  }

  try {
    const body = (await req.json().catch(() => ({}))) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json({ error: "enabled (boolean) required" }, { status: 400 });
    }
    await setBrandChromeEnabled(body.enabled, session?.user.id);
    return NextResponse.json({ enabled: body.enabled });
  } catch (err) {
    return apiError(err);
  }
}
