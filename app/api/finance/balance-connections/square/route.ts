/**
 * GET  /api/finance/balance-connections/square   what to connect, and what setup is still missing
 * POST /api/finance/balance-connections/square   record an opening balance (the anchor)
 *
 * The Square-specific half of the balance setup flow, behind Settings > Finance
 * > Square Connection. It does only the two things the shared plumbing cannot,
 * and deliberately duplicates nothing else:
 *
 *   * Creating/removing the connection row is `PUT`/`DELETE
 *     /api/finance/balance-connections`, the endpoint all three integrations
 *     share -- the settings screen calls it directly, exactly as Ramp's does.
 *   * Attaching a connection to a GL account is the picker on Settings >
 *     Balance Sheet Accounts, so there stays one place an account gets a source.
 *
 * ── Why Square needs a setup screen at all, when Ramp's just picks an account ─
 * Ramp's flow is a choice: list treasury accounts, connect one. Square has
 * nothing to choose -- the stored balance is merchant-wide, one per business.
 * What Square needs instead is an OPENING ANCHOR, because it publishes no
 * balance and the derivation has nowhere to start without one. That is the
 * genuinely per-integration step here, and it is why POST exists.
 *
 * ── No credential is entered here ────────────────────────────────────────────
 * Square authenticates with one business-wide token from env, shared with every
 * other Square reader in the app. There is nothing to type in and nothing to
 * reconnect.
 *
 * ── The anchor is an ordinary manual entry ───────────────────────────────────
 * It is not stored on the connection. Anchors must be editable, auditable and
 * re-entered every month by a person, and `manual_entries` already is all three
 * -- with the month-end close workflow, the one-balance-per-period guard and
 * the Manual Entries screen attached. A second private store for the same fact
 * would mean two places to look and two that can disagree. POST here writes
 * exactly the row that screen writes, through the same validator, so the
 * opening balance and every later month end are the same kind of thing.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { squareGetAll } from "@/lib/square/client";
import { listConnections } from "@/lib/finance/balances/connections";
import { validateManualEntry } from "@/lib/finance/manualEntries";

export const dynamic = "force-dynamic";

/** The method key whose accounts need a Square anchor. */
const SQUARE_METHOD = "squareStoredBalance";

type AdminClient = ReturnType<typeof createSupabaseAdminClient>;

interface RawLocation {
  id: string;
  name?: string;
  status?: string;
}

interface SquareAccount {
  coaId: string;
  accountNumber: string | null;
  accountName: string;
  /** The connection this account's source points at, if any. */
  connectionId: string | null;
  /** Most recent operator-entered balance, which the derivation starts from. */
  anchor: { asOfDate: string; cents: number } | null;
}

/**
 * Every GL account whose selected method is the Square balance, with the anchor
 * each one currently has.
 *
 * This is what makes the screen able to say WHICH of the setup steps is
 * outstanding. Without it an operator who has connected Square but never
 * entered an opening balance sees a blank account and nothing explaining why.
 */
async function squareAccounts(supabase: AdminClient): Promise<SquareAccount[]> {
  const { data: sources, error: sourcesError } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, config")
    .eq("provider_key", SQUARE_METHOD)
    .eq("active", true);
  if (sourcesError) throw new Error(sourcesError.message);

  const rows = (sources ?? []) as { chart_of_accounts_id: string; config: Record<string, unknown> | null }[];
  if (rows.length === 0) return [];

  const coaIds = rows.map((r) => r.chart_of_accounts_id);

  const { data: coaRows, error: coaError } = await supabase
    .from("chart_of_accounts")
    .select("id, account_number, account_name")
    .in("id", coaIds);
  if (coaError) throw new Error(coaError.message);
  const coaById = new Map(
    ((coaRows ?? []) as { id: string; account_number: string | null; account_name: string }[]).map((c) => [c.id, c]),
  );

  // Newest first, so the first row seen per account is its latest anchor.
  const { data: anchorRows, error: anchorError } = await supabase
    .from("manual_entries")
    .select("chart_of_accounts_id, as_of_date, amount_cents")
    .eq("entry_kind", "balance")
    .in("chart_of_accounts_id", coaIds)
    .order("as_of_date", { ascending: false });
  if (anchorError) throw new Error(anchorError.message);

  const latestAnchor = new Map<string, { asOfDate: string; cents: number }>();
  for (const row of (anchorRows ?? []) as { chart_of_accounts_id: string; as_of_date: string; amount_cents: number }[]) {
    if (!latestAnchor.has(row.chart_of_accounts_id)) {
      latestAnchor.set(row.chart_of_accounts_id, { asOfDate: row.as_of_date, cents: row.amount_cents });
    }
  }

  return rows.map((r) => {
    const coa = coaById.get(r.chart_of_accounts_id);
    const connectionId = r.config?.connectionId;
    return {
      coaId: r.chart_of_accounts_id,
      accountNumber: coa?.account_number ?? null,
      accountName: coa?.account_name ?? r.chart_of_accounts_id,
      connectionId: typeof connectionId === "string" ? connectionId : null,
      anchor: latestAnchor.get(r.chart_of_accounts_id) ?? null,
    };
  });
}

export async function GET() {
  try { await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();

    const locations = (await squareGetAll<RawLocation>("/locations", "locations"))
      .filter((l) => l.status !== "INACTIVE")
      .map((l) => ({ id: l.id, name: l.name ?? l.id }));

    const [connections, accounts] = await Promise.all([listConnections(supabase, "square"), squareAccounts(supabase)]);

    return NextResponse.json({ locations, connections, accounts });
  } catch (err) {
    return apiError(err);
  }
}

interface AnchorBody {
  chartOfAccountsId?: string;
  asOfDate?: string;
  amountCents?: number;
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const actorId = session.user.id;

  try {
    const body = (await req.json()) as AnchorBody;

    const validation = validateManualEntry({
      entryKind: "balance",
      chartOfAccountsId: body.chartOfAccountsId,
      asOfDate: body.asOfDate,
      amountCents: body.amountCents,
    } as never);
    if (!validation.ok) return NextResponse.json({ error: validation.error }, { status: 400 });

    const supabase = createSupabaseAdminClient();

    // Select-then-write rather than upsert: manual_entries' one-balance-per-
    // period guard is a PARTIAL unique index (`where entry_kind = 'balance'`),
    // and ON CONFLICT cannot infer a partial index without repeating its
    // predicate, which PostgREST has no way to express. An upsert here would
    // fail at runtime rather than at review.
    const { data: existing, error: findError } = await supabase
      .from("manual_entries")
      .select("id")
      .eq("entry_kind", "balance")
      .eq("chart_of_accounts_id", body.chartOfAccountsId)
      .eq("as_of_date", body.asOfDate)
      .maybeSingle();
    if (findError) throw new Error(findError.message);

    const { error } = existing
      ? await supabase
          .from("manual_entries")
          .update({ amount_cents: body.amountCents, updated_by: actorId })
          .eq("id", (existing as { id: string }).id)
      : await supabase.from("manual_entries").insert({
          entry_kind: "balance",
          chart_of_accounts_id: body.chartOfAccountsId,
          as_of_date: body.asOfDate,
          amount_cents: body.amountCents,
          label: "Square balance",
          mapping_source: "manual",
          created_by: actorId,
          updated_by: actorId,
        });
    if (error) throw new Error(error.message);

    return NextResponse.json({ ok: true, replaced: Boolean(existing) });
  } catch (err) {
    return apiError(err);
  }
}
