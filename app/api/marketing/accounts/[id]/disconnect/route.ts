/**
 * Unlink a channel login.
 *
 * The row survives — deliveries reference it, and where a post went is a
 * historical fact that unlinking must not erase. What goes is the credential:
 * `status` becomes `disconnected` and `credentials` is emptied, which is the
 * entire point of pressing this button.
 *
 * The response carries the account WITHOUT its credentials column, because
 * lib/marketing/accounts.ts never selects that column into anything.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { disconnectAccount } from "@/lib/marketing/accounts";
import { MarketingRequestError } from "@/lib/marketing/errors";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    await requirePermission(CAP.marketingAccountsManage);
  } catch (res) {
    return res as Response;
  }

  const { id } = await context.params;
  try {
    const account = await disconnectAccount(createSupabaseAdminClient(), id);
    return NextResponse.json({ ok: true, account });
  } catch (err) {
    if (err instanceof MarketingRequestError) return apiError(err.message, err.status);
    return apiError(err);
  }
}
