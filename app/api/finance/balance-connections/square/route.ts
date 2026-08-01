/**
 * GET  /api/finance/balance-connections/square   what Square offers, and what is still missing
 * POST /api/finance/balance-connections/square   create the connection, optionally with its opening anchor
 *
 * The Square-specific SETUP flow. The generic balance-connections route owns
 * create/update/delete once a connection exists; what it cannot do is discover
 * what there is to connect TO, which is per-integration by definition. This
 * route does that and nothing more -- it deliberately does not duplicate the
 * generic route's update or delete paths.
 *
 * ── Why setting up Square is three steps, not one ────────────────────────────
 * Square has no balance endpoint, so an account is only usable once all three
 * of these are true, and a half-configured account reads as unsourced rather
 * than as a wrong number:
 *
 *   1. a Square connection row exists            <- this route
 *   2. an opening balance is on record           <- this route, or Manual Entries
 *   3. the account selects the Square balance
 *      method and picks that connection          <- Settings > Balance Sheet Accounts
 *
 * GET reports which of the three are done, because the failure mode otherwise
 * is an operator who has done two of them and sees a blank account with nothing
 * telling them which one is missing.
 *
 * ── The anchor is an ordinary manual entry ───────────────────────────────────
 * It is not stored on the connection. Anchors have to be editable, auditable
 * and enterable every month by a person, and manual_entries already is all
 * three -- with the month-end close workflow, the unique-per-period constraint
 * and the existing UI attached. A second private store for the same fact would
 * mean two places to look and two that can disagree. The optional anchor here
 * writes exactly the row the Manual Entries screen writes, through the same
 * validator.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import { squareGetAll } from "@/lib/square/client";
import { listConnections, upsertConnection } from "@/lib/finance/balances/connections";
import { validateManualEntry } from "@/lib/finance/manualEntries";

export const dynamic = "force-dynamic";

interface RawLocation {
  id: string;
  name?: string;
  status?: string;
}

/** GL accounts already pointed at the Square balance method. */
async function squareSourcedAccountIds(supabase: ReturnType<typeof createSupabaseAdminClient>): Promise<string[]> {
  const { data, error } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id")
    .eq("provider_key", "squareStoredBalance")
    .eq("active", true);
  if (error) throw new Error(error.message);
  return ((data ?? []) as { chart_of_accounts_id: string }[]).map((r) => r.chart_of_accounts_id);
}

export async function GET() {
  try { await requirePermission(CAP.financeStatementsRead); } catch (res) { return res as Response; }

  try {
    const supabase = createSupabaseAdminClient();

    const locations = (await squareGetAll<RawLocation>("/locations", "locations"))
      .filter((l) => l.status !== "INACTIVE")
      .map((l) => ({ id: l.id, name: l.name ?? l.id }));

    const connections = await listConnections(supabase, "square");
    const sourcedAccountIds = await squareSourcedAccountIds(supabase);

    const { data: anchorRows, error: anchorError } = sourcedAccountIds.length
      ? await supabase
          .from("manual_entries")
          .select("chart_of_accounts_id, as_of_date, amount_cents")
          .eq("entry_kind", "balance")
          .in("chart_of_accounts_id", sourcedAccountIds)
          .order("as_of_date", { ascending: false })
      : { data: [], error: null };
    if (anchorError) throw new Error(anchorError.message);

    const latestAnchorByAccount = new Map<string, { asOfDate: string; cents: number }>();
    for (const row of (anchorRows ?? []) as { chart_of_accounts_id: string; as_of_date: string; amount_cents: number }[]) {
      if (!latestAnchorByAccount.has(row.chart_of_accounts_id)) {
        latestAnchorByAccount.set(row.chart_of_accounts_id, { asOfDate: row.as_of_date, cents: row.amount_cents });
      }
    }

    return NextResponse.json({
      locations,
      connections,
      setup: {
        connectionCreated: connections.length > 0,
        accountsUsingSquare: sourcedAccountIds.length,
        accountsMissingAnchor: sourcedAccountIds.filter((id) => !latestAnchorByAccount.has(id)).length,
      },
      anchors: Object.fromEntries(latestAnchorByAccount),
    });
  } catch (err) {
    return apiError(err);
  }
}

interface PostBody {
  label?: string;
  /** Square location this connection represents. Optional — the balance is merchant-wide. */
  locationId?: string | null;
  /** Optional opening anchor, written as a manual balance entry. */
  anchor?: { chartOfAccountsId?: string; asOfDate?: string; amountCents?: number };
}

export async function POST(req: NextRequest) {
  let session;
  try { session = await requirePermission(CAP.financeTransactionsManage); } catch (res) { return res as Response; }
  const actorId = session.user.id;

  try {
    const body = (await req.json()) as PostBody;
    const label = typeof body.label === "string" && body.label.trim() ? body.label.trim() : "Square · Deposit balance";

    const supabase = createSupabaseAdminClient();

    // No credentials are written. Square authenticates with one business-wide
    // token from the environment, which is not in the database, not in backups
    // and not reachable by SQL. The row exists to record WHICH Square account
    // maps to the GL account and to drive the Settings health line.
    const connection = await upsertConnection(
      supabase,
      {
        provider: "square",
        label,
        externalId: body.locationId ?? null,
        config: {},
        status: "active",
      },
      actorId,
    );

    let anchorWritten = false;
    if (body.anchor) {
      const input = {
        entryKind: "balance" as const,
        chartOfAccountsId: body.anchor.chartOfAccountsId,
        asOfDate: body.anchor.asOfDate,
        amountCents: body.anchor.amountCents,
      };
      const validation = validateManualEntry(input as never);
      if (!validation.ok) {
        // The connection is already created and is legitimately useful on its
        // own, so report the anchor problem without pretending nothing happened.
        return NextResponse.json(
          { connection, anchorWritten: false, error: `Connection created, but the opening balance was rejected: ${validation.error}` },
          { status: 400 },
        );
      }

      // Select-then-write rather than upsert: manual_entries' one-balance-per-
      // period guard is a PARTIAL unique index (`where entry_kind = 'balance'`),
      // and ON CONFLICT cannot infer a partial index without repeating its
      // predicate, which PostgREST has no way to express. An upsert here would
      // fail at runtime rather than at review.
      const { data: existing, error: findError } = await supabase
        .from("manual_entries")
        .select("id")
        .eq("entry_kind", "balance")
        .eq("chart_of_accounts_id", body.anchor.chartOfAccountsId)
        .eq("as_of_date", body.anchor.asOfDate)
        .maybeSingle();
      if (findError) throw new Error(findError.message);

      const { error } = existing
        ? await supabase
            .from("manual_entries")
            .update({ amount_cents: body.anchor.amountCents, updated_by: actorId })
            .eq("id", (existing as { id: string }).id)
        : await supabase.from("manual_entries").insert({
            entry_kind: "balance",
            chart_of_accounts_id: body.anchor.chartOfAccountsId,
            as_of_date: body.anchor.asOfDate,
            amount_cents: body.anchor.amountCents,
            label: "Square opening balance",
            mapping_source: "manual",
            created_by: actorId,
            updated_by: actorId,
          });
      if (error) throw new Error(error.message);
      anchorWritten = true;
    }

    return NextResponse.json({ connection, anchorWritten });
  } catch (err) {
    return apiError(err);
  }
}
