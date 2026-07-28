#!/usr/bin/env node
// Scoped-permissions guard. Warn-only unless --strict.
// See docs/superpowers/specs/2026-07-25-scoped-permissions-design.md
//
// Four rules, each closing a way the permission model can silently rot:
//   1. requireRole is retired — its return would be a gate nobody enforces.
//   2. Legacy-role comparisons bypass the resolver entirely, which is how the
//      UI and API drifted apart before this refactor.
//   3. A CAP entry nothing references is a permission that cannot be granted.
//   4. A scope no capability covers is a scope the admin UI can offer but
//      nothing honors.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const STRICT = process.argv.includes("--strict");
const AUTH_DIR = join("lib", "auth");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

const files = [join(ROOT, "app"), join(ROOT, "lib")]
  .flatMap((d) => walk(d))
  .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

const problems = [];
const inAuth = (p) => p.startsWith(AUTH_DIR);

// ── 1. requireRole is retired ───────────────────────────────────────────────
for (const { path, text } of files) {
  if (inAuth(path)) continue; // fixture + tests reference the name in prose
  text.split("\n").forEach((line, i) => {
    if (/\brequireRole\s*\(/.test(line))
      problems.push(`${path}:${i + 1} — requireRole is retired; use requirePermission(CAP.x)`);
  });
}

// ── 2. No legacy-role comparisons outside lib/auth ──────────────────────────
// Only the four legacy roles are banned. Comparing a profile row's role to
// "custom" (e.g. to decide whether to show the grant matrix) is legitimate.
const LEGACY_ROLE_CMP = /\brole\s*[!=]==\s*["'](viewer|brewer|manager|admin)["']/;
for (const { path, text } of files) {
  if (inAuth(path)) continue;
  text.split("\n").forEach((line, i) => {
    if (LEGACY_ROLE_CMP.test(line))
      problems.push(`${path}:${i + 1} — legacy role comparison bypasses the resolver; gate on a CAP entry`);
  });
}

// ── 3. Every CAP entry is referenced somewhere ──────────────────────────────
const capSrc = readFileSync(join(ROOT, AUTH_DIR, "capabilities.ts"), "utf8");
const capNames = [...capSrc.matchAll(/^\s{2}(\w+):\s*\{\s*scope:/gm)].map((m) => m[1]);
const consumers = files.filter(({ path }) => !inAuth(path));
for (const name of capNames) {
  const used = consumers.some(({ text }) => new RegExp(`CAP\\.${name}\\b`).test(text));
  // A capability referenced only by a layout or nav config still counts as
  // used — the four `<section>.access` leaves are admission-only and by design
  // have no API route at all.
  if (!used) problems.push(`lib/auth/capabilities.ts — CAP.${name} is never referenced`);
}

// ── 4. Every scope is covered by at least one capability ────────────────────
// Keys are quoted only when they aren't a bare identifier (e.g. "taproom.
// performance"; but `payroll` and `tax` are unquoted since they're valid
// identifiers) — the quotes must be optional, or unquoted keys are silently
// skipped.
const scopeSrc = readFileSync(join(ROOT, AUTH_DIR, "scopes.ts"), "utf8");
const scopeKeys = [...scopeSrc.matchAll(/^\s{2}"?([\w.]+)"?:\s*\{\s*label/gm)].map((m) => m[1]);
// Twenty-seven leaves is the documented shape (see scopes.ts's own header comment,
// and roleGrants.test.ts's "grants admin on all 27 scopes" assertion) — if
// this count drifts, the extraction regex silently under- or over-matched
// and every downstream check in this rule is unreliable.
if (scopeKeys.length !== 27) {
  problems.push(
    `scripts/check-permissions.mjs rule 4 — expected to find 27 scopes in lib/auth/scopes.ts, found ${scopeKeys.length}; ` +
      `the extraction regex is out of sync with scopes.ts's shape`,
  );
}
for (const key of scopeKeys) {
  if (!new RegExp(`scope:\\s*["']${key.replace(/\./g, "\\.")}["']`).test(capSrc))
    problems.push(`lib/auth/scopes.ts — scope "${key}" has no capability; nothing can grant it`);
}

// ── 5. Client modules must not value-import the server-reaching barrel ──────
for (const { path, text } of files) {
  if (!/^["']use client["']/m.test(text)) continue;
  text.split("\n").forEach((line, i) => {
    if (/from\s+["']@\/lib\/auth["']/.test(line) && !/^\s*import\s+type\b/.test(line))
      problems.push(
        `${path}:${i + 1} — client module value-imports @/lib/auth; it re-exports getSessionUser ` +
          `(next/headers) and breaks the build. Import from @/lib/auth/capabilities or /resolve.`,
      );
  });
}

if (problems.length === 0) {
  console.log("check-permissions: clean");
  process.exit(0);
}
console.error(`check-permissions: ${problems.length} problem(s)\n`);
for (const p of problems) console.error("  " + p);
process.exit(STRICT ? 1 : 0);
