import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { listGlDefaultRules, type GlRuleScope } from "@/lib/finance/glDefaultRules";

export const dynamic = "force-dynamic";

// GET — every standing GL default rule, so the mapping tree can show which
// scopes auto-apply to newly-synced variations.
export async function GET() {
  try { await requirePermission(CAP.financeTransactionsRead); } catch (res) { return res as Response; }

  try {
    return NextResponse.json(await listGlDefaultRules(createSupabaseAdminClient()));
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

// DELETE — stop auto-applying a scope's default. Deliberately leaves every
// variation the rule has already mapped alone: those are real mappings a person
// asked for, and revoking the standing intent is not the same as unmapping the
// catalog.
export async function DELETE(req: NextRequest) {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  const body = await req.json() as { scope?: GlRuleScope; scope_key?: string | null };
  if (!body.scope || !["parent", "category", "item"].includes(body.scope)) {
    return NextResponse.json({ error: "scope must be parent, category or item" }, { status: 400 });
  }

  const supabase = createSupabaseAdminClient();
  let q = supabase.from("square_gl_default_rules").delete().eq("scope", body.scope);
  // NULL scope_key is the Uncategorized group — a real scope, matched with `is`.
  q = body.scope_key == null ? q.is("scope_key", null) : q.eq("scope_key", body.scope_key);
  const { error } = await q;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ ok: true });
}
