#!/usr/bin/env -S node --import tsx --env-file=.env.local
/**
 * Balance-sheet equivalence gate.
 *
 * Runs the NEW provider path against production and compares every account to
 * `lib/finance/balances/__fixtures__/goldenBalanceSheet.ts` — a frozen capture
 * of what the PRE-PR-B pipeline produced from the same database. Exits non-zero
 * on any drift.
 *
 * Run it before merging PR B, and again after applying its migration:
 *   ./scripts/balance-sheet-parity.ts
 *
 * WHY A SCRIPT AND NOT A UNIT TEST: the assertion that matters is "the new path
 * reproduces the old path's numbers on the real dataset". A fixture-fed unit
 * test can only check the logic against rows someone chose, and choosing those
 * rows is exactly where the previous gate went wrong. This follows the existing
 * `scripts/financials-parity.ts` precedent for the same reason.
 *
 * WHAT THE PREVIOUS GATE DID WRONG: it computed its expectation by calling
 * `normalizeSignedCents` — the function under test — and asserted the flip was
 * its negation. True by construction for any flip function. It never ran a
 * provider, never wrote or read a snapshot, and never compared against
 * pre-branch output. Six real defects passed it.
 *
 * Sign convention: internal (assets positive, liabilities/equity negative),
 * pre-presentation-flip. See the fixture header.
 */
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getProvider } from "@/lib/finance/balances/registry";
import "@/lib/finance/balances/providers";
import {
  GOLDEN_BY_ACCOUNT,
  GOLDEN_BALANCE_SHEET,
  GOLDEN_PERIOD_END,
  GOLDEN_CAPTURED_AT_COMMIT,
} from "@/lib/finance/balances/__fixtures__/goldenBalanceSheet";

function usd(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
}

async function main(): Promise<void> {
  const supabase = createSupabaseAdminClient();

  const { data: coaRows, error: coaErr } = await supabase
    .from("chart_of_accounts")
    .select("id, account_number, account_name");
  if (coaErr) throw new Error(`chart_of_accounts: ${coaErr.message}`);
  const numberById = new Map((coaRows ?? []).map((c) => [c.id as string, c.account_number as string | null]));

  const { data: sources, error: srcErr } = await supabase
    .from("balance_sheet_account_sources")
    .select("chart_of_accounts_id, provider_key, config, active")
    .eq("active", true);
  if (srcErr) throw new Error(`balance_sheet_account_sources: ${srcErr.message}`);

  // Compute every configured account through the real providers.
  const computed = new Map<string, { cents: number; contributions: Record<string, number> }>();
  for (const src of sources ?? []) {
    const acctNo = numberById.get(src.chart_of_accounts_id as string);
    if (!acctNo) continue;
    const provider = getProvider(src.provider_key as string);
    if (!provider) {
      console.error(`  ✗ ${acctNo}: source names unregistered provider "${src.provider_key}"`);
      continue;
    }
    // A THROW must not be silently read as "no balance" — that is how a
    // transient 5xx writes a partial sum over a good snapshot.
    let value: number | null;
    try {
      value = await provider.compute({
        supabase,
        periodEnd: GOLDEN_PERIOD_END,
        coaId: src.chart_of_accounts_id as string,
        config: (src.config ?? {}) as Record<string, unknown>,
      });
    } catch (err) {
      console.error(`  ✗ ${acctNo}/${provider.key}: THREW — ${(err as Error).message}`);
      process.exitCode = 1;
      continue;
    }
    if (value === null) continue;
    const entry = computed.get(acctNo) ?? { cents: 0, contributions: {} };
    entry.cents += value;
    entry.contributions[provider.key] = value;
    computed.set(acctNo, entry);
  }

  console.log(`Balance-sheet parity — new provider path vs golden capture`);
  console.log(`  golden: commit ${GOLDEN_CAPTURED_AT_COMMIT}, period end ${GOLDEN_PERIOD_END}\n`);

  const accounts = new Set<string>([...GOLDEN_BY_ACCOUNT.keys(), ...computed.keys()]);
  let drift = 0;

  for (const acctNo of [...accounts].sort()) {
    const golden = GOLDEN_BY_ACCOUNT.get(acctNo);
    const actual = computed.get(acctNo);
    // A knownDivergence account must match the NEW expected value, not the old
    // one. Matching the old value there means a real bug was reproduced.
    const want = golden?.knownDivergence?.expectedNewCents ?? golden?.totalCents ?? 0;
    const got = actual?.cents ?? 0;

    if (golden?.knownDivergence && got === golden.totalCents) {
      drift++;
      console.error(
        `  ✗ ${acctNo}  reproduced the OLD value ${usd(got)} — this account has a known\n` +
        `        divergence and must NOT match the old pipeline. Expected ${usd(want)}.\n` +
        `        ${golden.knownDivergence.why}`,
      );
      continue;
    }

    if (want === got) {
      console.log(`  ✓ ${acctNo}  ${usd(got).padStart(14)}`);
      continue;
    }

    drift++;
    const contribs = actual
      ? Object.entries(actual.contributions).map(([k, v]) => `${k}=${v}`).join(", ")
      : "(no source configured)";
    if (!golden) {
      console.error(
        `  ✗ ${acctNo}  INVENTED ${usd(got)} — the old pipeline produced nothing here\n` +
        `        contributions: ${contribs}`,
      );
    } else if (!actual) {
      console.error(
        `  ✗ ${acctNo}  LOST ${usd(want)} — old pipeline had it from [${golden.sources.join(", ")}], ` +
        `new path produces nothing\n        ${golden.accountName}`,
      );
    } else {
      console.error(
        `  ✗ ${acctNo}  want ${usd(want)}, got ${usd(got)}  (off by ${usd(got - want)})\n` +
        `        old sources: [${golden.sources.join(", ")}]\n` +
        `        contributions: ${contribs}`,
      );
    }
  }

  console.log();
  if (drift === 0) {
    console.log(`PARITY OK — all ${GOLDEN_BALANCE_SHEET.length} golden accounts reproduced exactly.`);
    return;
  }
  console.error(`PARITY FAILED — ${drift} account(s) drifted. Do not merge.`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
