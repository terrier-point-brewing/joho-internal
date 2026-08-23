#!/usr/bin/env node
// Marketing import-boundary guard. Warn-only unless --strict.
//
// WHY THIS EXISTS. Marketing is the first part of this app with an enforced
// boundary, and that is deliberate — not an oversight everywhere else.
//
// Every other section grew by reaching for whatever it needed, which is why
// `lib/finance` and `lib/production` now know about each other in a dozen
// places nobody chose. Marketing is being built as a chassis with pluggable
// channels and, later, an assistant that proposes work. It is the part of the
// app most likely to be replaced, extracted, or run against a different set of
// integrations, and that is only cheap if the seam is real.
//
// So two rules, in opposite directions:
//
//   1. Nothing outside marketing imports marketing. If the rest of the app
//      never depends on it, marketing can be rewritten without a survey.
//   2. Marketing imports the host narrowly. Only shared infrastructure
//      (auth, supabase, utils, cron, UI components) — never another section's
//      lib/ or app/. When marketing needs something a section knows, the
//      sanctioned route is a read-only port declared in lib/marketing/ports/
//      and implemented by the host.
//
// If you are here because this script blocked you: the fix is almost never to
// widen the allowlist. It is a port.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname, normalize } from "node:path";

const ROOT = process.cwd();
const STRICT = process.argv.includes("--strict");

/** Directories that ARE marketing. Everything else is "outside". */
const MARKETING_DIRS = [
  join("app", "marketing"),
  join("app", "api", "marketing"),
  join("lib", "marketing"),
  join("app", "settings", "marketing"),
];

/** Aliased specifiers that resolve into marketing. */
const MARKETING_ALIASES = ["@/app/marketing", "@/lib/marketing", "@/app/api/marketing", "@/app/settings/marketing"];

/**
 * The settings hub's own chrome, which marketing's settings screen is MOUNTED
 * INTO.
 *
 * This is rule 1's exception list read in the other direction. `/settings` is
 * one route group with one shell: every group layout wraps itself in
 * `SettingsGroupShell` (which renders the group row and provides the sub-nav
 * context) and every group page titles itself with `SettingsHeader`. A settings
 * screen that declined to use them would not be a more independent marketing —
 * it would be a settings screen that looks like nothing else in settings, which
 * is the exact failure docs/UI_STANDARD.md §4 exists to prevent.
 *
 * Two exact modules, both pure presentation, neither of which reads marketing's
 * data. They are listed by full path rather than as an `@/app/settings` prefix
 * so this does not become a door onto another section's settings logic — the
 * finance mapping hooks and the payroll config live under that prefix too.
 *
 * If marketing is ever extracted, these two are the seam: a host without them
 * supplies its own shell, and `app/settings/marketing/**` is the only place
 * that has to change.
 */
const SETTINGS_CHASSIS = ["@/app/settings/SettingsGroupShell", "@/app/settings/SettingsHeader"];

/**
 * Host modules marketing may import. Shared infrastructure only — anything
 * with a section's name in it is absent on purpose.
 */
const HOST_ALLOWED = [
  "@/lib/auth",
  "@/lib/supabase",
  "@/lib/utils",
  "@/lib/cron",
  "@/app/components",
  ...SETTINGS_CHASSIS,
  ...MARKETING_ALIASES,
];

/**
 * Rule 1's named exceptions — the host MOUNTING marketing, which is not the
 * same thing as depending on it.
 *
 * Both entries are one host file whose entire job is to give marketing a place
 * to hang: the sidebar renders its nav, and the cron registry gives its worker
 * a schedule. Neither reads marketing's data or reaches into its internals, and
 * neither would survive marketing being deleted — which is the test. A module
 * that merely WANTED something marketing knows would be a port instead.
 *
 * Each entry is one exact file paired with one exact module specifier, and it
 * stays that way. A `lib/cron/**` → `@/lib/marketing/**` wildcard would let any
 * future job reach into any part of marketing, which is the hole this list
 * exists to avoid. If a new mounting point is genuinely needed, it gets its own
 * one-file, one-module row here and a sentence saying why.
 */
const RULE_1_EXCEPTIONS = [
  {
    // Every section's sidebar block imports that section's nav config;
    // pretending marketing is different would mean the sidebar cannot render it
    // at all.
    file: join("app", "components", "NavBar.tsx"),
    spec: "@/app/marketing/nav-config",
  },
  {
    // The scheduled publishing job. This wrapper is deliberately a file of its
    // own rather than an import in lib/cron/jobs/index.ts: index.ts is pulled
    // in by every cron route, and the seam belongs on the one module that
    // exists to mount marketing, not on the shared registry.
    file: join("lib", "cron", "jobs", "marketingDeliveries.ts"),
    spec: "@/lib/marketing/worker",
  },
];

/** How the exceptions read in a violation message. */
const EXCEPTIONS_SUMMARY = RULE_1_EXCEPTIONS.map((e) => `${e.file} importing "${e.spec}"`).join("; ");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|cts)$/.test(name)) out.push(full);
  }
  return out;
}

/** Every module specifier in a file, with the line it sits on. */
function importsOf(text) {
  const found = [];
  text.split("\n").forEach((line, i) => {
    // static `from "x"`, bare `import "x"`, dynamic `import("x")`, `require("x")`
    const patterns = [
      /\bfrom\s+["']([^"']+)["']/g,
      /^\s*import\s+["']([^"']+)["']/g,
      /\bimport\(\s*["']([^"']+)["']\s*\)/g,
      /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const re of patterns) {
      for (const m of line.matchAll(re)) found.push({ spec: m[1], line: i + 1 });
    }
  });
  return found;
}

const underAny = (path, dirs) => dirs.some((d) => path === d || path.startsWith(d + sep));
const matchesAlias = (spec, alias) => spec === alias || spec.startsWith(alias + "/");

/**
 * Where a relative specifier actually lands, as a repo-relative path.
 *
 * Both rules below would otherwise see only `@/` aliases, and a relative
 * import crosses the same seam while looking like a local one:
 * `../../lib/finance/x` from app/marketing/ is the identical dependency as
 * `@/lib/finance/x`, spelled differently. Returns null for a package
 * specifier, which is never a boundary question.
 */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith(".")) return null;
  return normalize(join(dirname(fromFile), spec));
}

const files = [join(ROOT, "app"), join(ROOT, "lib")]
  .flatMap((d) => walk(d))
  .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

const violations = [];

for (const { path, text } of files) {
  const isMarketing = underAny(path, MARKETING_DIRS);

  for (const { spec, line } of importsOf(text)) {
    if (isMarketing) {
      // ── Rule 2: marketing imports the host narrowly ───────────────────────
      const resolved = resolveRelative(path, spec);
      // A relative path that stays inside marketing is just a local import.
      if (resolved !== null && underAny(resolved, MARKETING_DIRS)) continue;
      // A relative path that does NOT stay inside marketing has escaped the
      // seam, so it falls through to the violation below alongside the alias
      // case. Anything else non-aliased is a package.
      if (resolved === null && !spec.startsWith("@/")) continue;
      if (HOST_ALLOWED.some((a) => matchesAlias(spec, a))) continue;
      violations.push({
        file: path,
        line,
        msg:
          `marketing imports "${spec}" — outside the host surface marketing may reach ` +
          `(${HOST_ALLOWED.join(", ")}). Declare a read-only port in lib/marketing/ports/ ` +
          `and have the host implement it.`,
      });
    } else {
      // ── Rule 1: nothing outside marketing imports marketing ───────────────
      const resolved = resolveRelative(path, spec);
      const reachesIn = resolved !== null
        ? underAny(resolved, MARKETING_DIRS)
        : MARKETING_ALIASES.some((a) => matchesAlias(spec, a));
      if (!reachesIn) continue;
      if (RULE_1_EXCEPTIONS.some((e) => path === e.file && spec === e.spec)) continue;
      violations.push({
        file: path,
        line,
        msg:
          `imports "${spec}" from outside marketing — marketing is a closed section, so nothing ` +
          `depends on it. The only exceptions are the host mounting marketing: ${EXCEPTIONS_SUMMARY}. ` +
          `Widening this list is almost never the fix — declare a read-only port in lib/marketing/ports/ instead.`,
      });
    }
  }
}

if (violations.length === 0) {
  console.log("✓ marketing boundary: no violations");
  process.exit(0);
}

const tag = STRICT ? "ERROR" : "WARN";
for (const v of violations) {
  console.log(`${tag} ${v.file}:${v.line} — ${v.msg}`);
}
console.log(`\n${violations.length} violation(s). ${STRICT ? "Failing (strict)." : "Warn-only (CI runs --strict)."}`);
process.exit(STRICT ? 1 : 0);
