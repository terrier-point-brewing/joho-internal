#!/usr/bin/env node
/**
 * Ramp API spike — READ-ONLY investigation for the unified transactions-ledger build.
 *
 * Purpose: before we commit to a data model for bills + bank-account money
 * movement, see the REAL field shapes Ramp returns for each resource — because
 * the public docs don't pin down (a) the GL-coding shape on bills, (b) whether
 * operating bank-account lines (Gusto/Erie debits, interest, transfers, card
 * payments) carry a machine-readable type/counterparty we can classify on, and
 * (c) the exact OAuth scope strings the app must be granted.
 *
 * It does NOT write anything to Ramp — only GETs and a client_credentials token.
 *
 * ── Run ──────────────────────────────────────────────────────────────────────
 *   node --env-file=.env.local scripts/ramp-api-spike.mjs
 *
 * Node 22+ only (native fetch + --env-file). No npm deps.
 *
 * Re-run after enabling new scopes in the Ramp dashboard (see SCOPE CHANGES in
 * the accompanying notes) — Phase 1 will show newly-granted scopes flip to PASS
 * and Phase 2 will then reach the previously-403 endpoints.
 *
 * Raw JSON samples are written to ./ramp-spike-output/ (safe to delete; add to
 * .gitignore). Nothing is committed by this script.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TOKEN_URL = "https://api.ramp.com/developer/v1/token";
const BASE = "https://api.ramp.com/developer/v1";
const OUT_DIR = "ramp-spike-output";

const CLIENT_ID = process.env.RAMP_CLIENT_ID;
const CLIENT_SECRET = process.env.RAMP_CLIENT_SECRET;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("✗ RAMP_CLIENT_ID / RAMP_CLIENT_SECRET not set. Run with: node --env-file=.env.local scripts/ramp-api-spike.mjs");
  process.exit(1);
}

const basicAuth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64");

/** Request a client_credentials token for exactly `scope`. Returns {ok, token, granted, error}. */
async function getToken(scope) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", scope }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    return { ok: false, error: data.error_v2?.message ?? data.error_description ?? data.error ?? `HTTP ${res.status}` };
  }
  // Ramp echoes the scopes actually granted on the token — capture them.
  return { ok: true, token: data.access_token, granted: data.scope ?? scope };
}

/** GET a path with a token. Returns {status, ok, json}. */
async function hit(token, path) {
  const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, json };
}

/** Union of top-level keys across items + which string/bool fields look categorical (≤12 distinct). */
function summarize(items) {
  const keys = new Set();
  const values = new Map(); // key -> Set of distinct scalar values (capped)
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    for (const [k, v] of Object.entries(it)) {
      keys.add(k);
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) {
        if (!values.has(k)) values.set(k, new Set());
        const set = values.get(k);
        if (set.size < 15) set.add(v);
      }
    }
  }
  const categorical = {};
  for (const [k, set] of values) {
    // Heuristic: short field names that read like a type/status, or any field
    // with a small distinct set of string values — these are the classifiers.
    const looksTypey = /type|status|state|kind|direction|category|class/i.test(k);
    if ((looksTypey && set.size <= 15) || (set.size > 0 && set.size <= 8)) {
      categorical[k] = [...set];
    }
  }
  return { keys: [...keys].sort(), categorical };
}

/** Pull just the accounting/GL coding blocks so we can see how each resource codes to a GL account. */
function extractCodingSample(item) {
  if (!item || typeof item !== "object") return null;
  const out = {};
  if ("accounting_field_selections" in item) out.top_level_accounting_field_selections = item.accounting_field_selections;
  if (Array.isArray(item.line_items)) {
    out.line_item_0_accounting_field_selections = item.line_items[0]?.accounting_field_selections ?? null;
    out.line_item_0_keys = item.line_items[0] ? Object.keys(item.line_items[0]) : null;
  }
  if ("amount" in item) out.amount_shape = item.amount;
  if ("gl_account" in item) out.gl_account = item.gl_account;
  return out;
}

async function dump(name, payload) {
  await writeFile(join(OUT_DIR, `${name}.json`), JSON.stringify(payload, null, 2));
}

// ── Phase 1: discover which scope strings the app accepts ──────────────────────
// Existing (known-good) scopes are requested as a baseline. The candidates are
// what we THINK the new resources need — the token endpoint tells us the truth.
const KNOWN_GOOD = "transactions:read statements:read cards:read users:read business:read reimbursements:read";

const CANDIDATE_SCOPES = [
  // bills / bill pay
  "bills:read",
  // bank / business-account money movement — exact string unknown, so probe all plausibles
  "banking:read",
  "business_account:read",
  "ramp_business_account:read",
  "transfers:read",
  "banking_transactions:read",
  "treasury:read",
  "accounting:read", // sometimes required to hydrate GL field names
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log("── Phase 1: scope discovery ─────────────────────────────────────");
  const baseline = await getToken(KNOWN_GOOD);
  console.log(baseline.ok ? `✓ baseline scopes OK (granted: ${baseline.granted})` : `✗ baseline FAILED: ${baseline.error}`);

  const workingScopes = [];
  for (const s of CANDIDATE_SCOPES) {
    const r = await getToken(s);
    if (r.ok) {
      workingScopes.push(s);
      console.log(`  ✓ ${s.padEnd(28)} accepted`);
    } else {
      console.log(`  ✗ ${s.padEnd(28)} rejected — ${r.error}`);
    }
  }
  console.log(`\nAccepted new scopes: ${workingScopes.length ? workingScopes.join(" ") : "(none — enable them in the Ramp dashboard, then re-run)"}`);

  // Token carrying everything the app currently grants (baseline + any accepted candidates).
  const fullScope = [KNOWN_GOOD, ...workingScopes].join(" ");
  const full = await getToken(fullScope);
  if (!full.ok) {
    console.log(`\n✗ Could not mint combined token: ${full.error}\nStopping after scope discovery.`);
    return;
  }
  const token = full.token;

  console.log("\n── Phase 2: endpoint field shapes ───────────────────────────────");

  // Small window keeps payloads readable; widen if a resource returns nothing.
  const today = new Date();
  const from = new Date(today); from.setUTCDate(from.getUTCDate() - 120);
  const fromStr = from.toISOString();
  const toStr = today.toISOString();

  const probes = [
    { name: "transactions", path: `/transactions?page_size=3&from_date=${fromStr}&to_date=${toStr}` },
    { name: "bills", path: `/bills?page_size=5` },
    { name: "banking-accounts", path: `/banking/accounts` },
    { name: "banking-syncable-transactions", path: `/banking/syncable-transactions?page_size=10` },
    { name: "transfers", path: `/transfers?page_size=10` },
  ];

  const bankingAccountIds = [];

  for (const p of probes) {
    const r = await hit(token, p.path);
    const items = Array.isArray(r.json?.data) ? r.json.data : (Array.isArray(r.json) ? r.json : []);
    console.log(`\n▸ ${p.name}  [${r.status}]  items: ${items.length}`);

    if (!r.ok) {
      console.log(`  error: ${r.json?.error_v2?.message ?? r.json?.error ?? "(none)"} — likely a missing scope (see Phase 1)`);
      await dump(p.name, { requested: p.path, status: r.status, body: r.json });
      continue;
    }

    const { keys, categorical } = summarize(items);
    console.log(`  keys: ${keys.join(", ")}`);
    if (Object.keys(categorical).length) {
      console.log(`  categorical fields (candidate classifiers):`);
      for (const [k, vals] of Object.entries(categorical)) console.log(`    ${k}: ${JSON.stringify(vals)}`);
    }
    const coding = items[0] ? extractCodingSample(items[0]) : null;
    if (coding) console.log(`  coding sample (item 0): ${JSON.stringify(coding).slice(0, 400)}${JSON.stringify(coding).length > 400 ? "…" : ""}`);

    if (p.name === "banking-accounts") {
      for (const a of items) if (a?.id) bankingAccountIds.push(a.id);
    }

    await dump(p.name, { requested: p.path, status: r.status, sample: items.slice(0, 5), summary: { keys, categorical } });
  }

  // Per-account balance history (needs the account id from banking-accounts).
  for (const id of bankingAccountIds.slice(0, 2)) {
    const path = `/banking/accounts/${id}/balance-history`;
    const r = await hit(token, path);
    const items = Array.isArray(r.json?.data) ? r.json.data : [];
    console.log(`\n▸ balance-history[${id.slice(0, 8)}…]  [${r.status}]  items: ${items.length}`);
    if (r.ok && items.length) console.log(`  keys: ${summarize(items).keys.join(", ")}`);
    await dump(`banking-balance-history-${id.slice(0, 8)}`, { requested: path, status: r.status, sample: items.slice(0, 5) });
  }

  console.log(`\n✓ Done. Raw samples written to ./${OUT_DIR}/`);
  console.log("  Key files to inspect:");
  console.log("   • bills.json                          → GL-coding shape on bills (the bill-mapper risk)");
  console.log("   • banking-syncable-transactions.json  → does a bank line carry a type/counterparty/coding?");
  console.log("   • transactions.json                   → confirms the card-txn coding shape still matches extractGlAccount");
}

main().catch((e) => { console.error("spike failed:", e); process.exit(1); });
