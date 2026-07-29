#!/usr/bin/env node
// Migration version guard. Warn-only unless --strict.
//
// A Supabase migration's VERSION is the digits before the first underscore —
// not the filename. So `20260825_scope_registry_restructure.sql` and
// `20260825_square_tax_accounts.sql` are the same version, and `supabase db
// push` will treat applying either one as having applied both. The second
// silently never runs.
//
// That already happened once: PRs #285 and #286 were developed in parallel on
// the same day and each numbered a pair 20260825/20260826. Both pairs were
// hand-applied so nothing was lost, but a fresh environment built with
// `db push` would have silently skipped two of the four.
//
// This repo has 33 pre-existing dates carrying more than one migration, from
// back when everything was applied by hand. Renaming applied history buys
// nothing, so those are grandfathered below with their exact file counts —
// exact, so that ADDING a file to a legacy date is still caught.
//
// New migrations must take a unique version. Either use an unused date, or the
// full `YYYYMMDDHHMMSS` stamp the Supabase CLI generates (which is what the
// 155 rows already in supabase_migrations.schema_migrations use).
import { readdirSync } from "node:fs";
import { join } from "node:path";

const STRICT = process.argv.includes("--strict");
const DIR = join(process.cwd(), "supabase", "migrations");

/** date -> number of migrations legitimately sharing it, as of 2026-07-28. */
const GRANDFATHERED = {
  "20260609": 3, "20260611": 2, "20260612": 4, "20260613": 6, "20260614": 5,
  "20260616": 3, "20260617": 3, "20260627": 6, "20260628": 3, "20260629": 4,
  "20260630": 3, "20260701": 3, "20260702": 2, "20260703": 2, "20260705": 3,
  "20260708": 7, "20260709": 6, "20260710": 2, "20260711": 4, "20260712": 2,
  "20260713": 4, "20260714": 3, "20260715": 3, "20260716": 2, "20260717": 2,
  "20260722": 3, "20260723": 2, "20260727": 3, "20260730": 2, "20260802": 2,
  "20260807": 2, "20260808": 2, "20260816": 2,
};

const byVersion = new Map();
for (const name of readdirSync(DIR)) {
  if (!name.endsWith(".sql")) continue;
  const version = name.split("_")[0];
  if (!/^\d+$/.test(version)) {
    console.error(`check-migrations: ${name} has no numeric version prefix`);
    process.exit(STRICT ? 1 : 0);
  }
  if (!byVersion.has(version)) byVersion.set(version, []);
  byVersion.get(version).push(name);
}

const problems = [];
for (const [version, files] of byVersion) {
  if (files.length === 1) continue;
  const allowed = GRANDFATHERED[version];
  if (allowed === files.length) continue;

  problems.push(
    allowed === undefined
      ? `version ${version} is used by ${files.length} migrations:\n` +
        files.map((f) => `      ${f}`).join("\n") +
        `\n    Give one a unique version — an unused date, or a full YYYYMMDDHHMMSS stamp.`
      : `version ${version} now has ${files.length} migrations but is grandfathered at ${allowed}:\n` +
        files.map((f) => `      ${f}`).join("\n") +
        `\n    Do not add to a legacy shared date; take a unique version instead.`,
  );
}

if (problems.length === 0) {
  console.log(`check-migrations: clean (${byVersion.size} distinct versions)`);
  process.exit(0);
}
console.error(`check-migrations: ${problems.length} problem(s)\n`);
for (const p of problems) console.error("  " + p + "\n");
process.exit(STRICT ? 1 : 0);
