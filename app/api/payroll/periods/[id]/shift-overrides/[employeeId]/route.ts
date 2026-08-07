import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/utils/api";
import { fetchDayGridInputs, computeDailyGrid, bucketViolations, type DayOverride } from "@/lib/payroll/dailyGrid";
import type { Employee, PayPeriod, TipPoolFrequency } from "@/lib/payroll/types";

export const dynamic = "force-dynamic";

interface CellInput {
  work_date: string;
  adj_hours: number | null;
  adj_paycheck_tips_cents: number | null;
  adj_cash_tips_cents: number | null;
  note?: string | null;
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; employeeId: string }> }
) {
  let session;
  try { session = await requirePermission(CAP.payrollDayOverride); } catch (res) { return res as Response; }

  const supabase = await createSupabaseServerClient();
  const { id, employeeId } = await params;

  const { data: period, error: pErr } = await supabase
    .from("pay_periods").select("id, start_date, end_date, status").eq("id", id).single();
  if (pErr || !period) return apiError("Period not found", 404);
  if (period.status !== "open") {
    return NextResponse.json({ error: "Period is locked" }, { status: 409 });
  }

  const body = await req.json().catch(() => null) as { cells?: CellInput[] } | null;
  if (!body || !Array.isArray(body.cells)) return apiError("Expected { cells: [] }", 400);

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const seenDates = new Set<string>();
  for (const c of body.cells) {
    if (typeof c.work_date !== "string" || !DATE_RE.test(c.work_date)) {
      return apiError("work_date must be a YYYY-MM-DD string", 400);
    }
    if (c.work_date < period.start_date || c.work_date > period.end_date) {
      return apiError(`${c.work_date} is outside this pay period`, 400);
    }
    if (seenDates.has(c.work_date)) {
      return apiError(`Duplicate work_date ${c.work_date} in cells`, 400);
    }
    seenDates.add(c.work_date);
    for (const v of [c.adj_hours, c.adj_paycheck_tips_cents, c.adj_cash_tips_cents]) {
      if (v != null && (!Number.isFinite(v) || v < 0)) {
        return apiError("Override values must be zero or greater", 400);
      }
    }
  }

  const kept = body.cells.filter(
    c => c.adj_hours != null || c.adj_paycheck_tips_cents != null || c.adj_cash_tips_cents != null
  );

  // Validate by running the real computation with the proposed override set,
  // so a write can never persist a state the read path would have to degrade.
  const [{ data: employees }, { data: config }, { data: otherRows }, { data: existingRows }] = await Promise.all([
    supabase.from("employees")
      .select("id, first_name, last_name, square_team_member_id, receives_tips, employment_type, active")
      .not("square_team_member_id", "is", null),
    supabase.from("payroll_config").select("tip_pool_frequency")
      .order("effective_from", { ascending: false }).limit(1).single(),
    supabase.from("payroll_shift_overrides")
      .select("employee_id, work_date, adj_hours, adj_paycheck_tips_cents, adj_cash_tips_cents, note")
      .eq("pay_period_id", id).neq("employee_id", employeeId),
    supabase.from("payroll_shift_overrides")
      .select("work_date, created_by, created_at")
      .eq("pay_period_id", id).eq("employee_id", employeeId),
  ]);

  const frequency = ((config as { tip_pool_frequency?: string } | null)?.tip_pool_frequency
    ?? "biweekly") as TipPoolFrequency;

  const proposed: DayOverride[] = [
    ...((otherRows ?? []) as DayOverride[]),
    ...kept.map(c => ({
      employee_id: employeeId,
      work_date: c.work_date,
      adj_hours: c.adj_hours,
      adj_paycheck_tips_cents: c.adj_paycheck_tips_cents,
      adj_cash_tips_cents: c.adj_cash_tips_cents,
      note: c.note ?? null,
    })),
  ];

  let grid;
  try {
    const inputs = await fetchDayGridInputs(period as PayPeriod);
    grid = computeDailyGrid(inputs, period as PayPeriod, (employees ?? []) as Employee[], frequency, proposed);
  } catch (err) {
    return apiError(err instanceof Error ? err.message : String(err));
  }

  const violations = bucketViolations(grid.buckets);
  if (violations.length > 0) {
    const v = violations[0];
    const usd = (c: number) => `$${(c / 100).toFixed(2)}`;
    const message = v.kind === "pins_exceed_pool"
      ? `Pinned card tips for ${v.label} total ${usd(v.pinnedCents)}, which exceeds the ${usd(v.poolCents)} pool.`
      : `No unpinned cell can absorb the remainder for ${v.label}; pins must total exactly ${usd(v.poolCents)}.`;
    return NextResponse.json({ error: message, violations }, { status: 422 });
  }

  // Upsert kept rows first, then delete anything stale for this employee-period.
  // In that order a failure at either step can only leave stale rows behind
  // for the next save to clean up — never data loss (unlike delete-then-insert).
  const existingByDate = new Map((existingRows ?? []).map(r => [r.work_date, r]));
  const nowIso = new Date().toISOString();

  if (kept.length > 0) {
    const { error: uErr } = await supabase.from("payroll_shift_overrides").upsert(
      kept.map(c => {
        const existing = existingByDate.get(c.work_date);
        return {
          pay_period_id: id,
          employee_id: employeeId,
          work_date: c.work_date,
          adj_hours: c.adj_hours,
          adj_paycheck_tips_cents: c.adj_paycheck_tips_cents,
          adj_cash_tips_cents: c.adj_cash_tips_cents,
          note: c.note ?? null,
          created_by: existing?.created_by ?? session.user.id,
          created_at: existing?.created_at ?? nowIso,
          updated_by: session.user.id,
        };
      }),
      { onConflict: "pay_period_id,employee_id,work_date" }
    );
    if (uErr) return apiError(uErr.message);
  }

  const keptDates = [...new Set(kept.map(c => c.work_date))];
  const { error: dErr } = keptDates.length > 0
    ? await supabase
        .from("payroll_shift_overrides").delete()
        .eq("pay_period_id", id).eq("employee_id", employeeId)
        .not("work_date", "in", `(${keptDates.join(",")})`)
    : await supabase
        .from("payroll_shift_overrides").delete()
        .eq("pay_period_id", id).eq("employee_id", employeeId);
  if (dErr) return apiError(dErr.message);

  return NextResponse.json({ ok: true, saved: kept.length });
}
