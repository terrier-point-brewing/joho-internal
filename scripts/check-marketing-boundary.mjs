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
import { join, relative, sep } from "node:path";

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
 * Host modules marketing may import. Shared infrastructure only — anything
 * with a section's name in it is absent on purpose.
 */
const HOST_ALLOWED = [
  "@/lib/auth",
  "@/lib/supabase",
  "@/lib/utils",
  "@/lib/cron",
  "@/app/components",
  ...MARKETING_ALIASES,
];

/**
 * Rule 1's one named exception. Every section's sidebar block imports that
 * section's nav config; pretending marketing is different would mean the
 * sidebar cannot render it at all. Narrow on purpose: this exact file, that
 * exact module.
 */
const NAVBAR_EXCEPTION = { file: join("app", "components", "NavBar.tsx"), spec: "@/app/marketing/nav-config" };

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

const files = [join(ROOT, "app"), join(ROOT, "lib")]
  .flatMap((d) => walk(d))
  .map((f) => ({ path: relative(ROOT, f), text: readFileSync(f, "utf8") }));

const violations = [];

for (const { path, text } of files) {
  const isMarketing = underAny(path, MARKETING_DIRS);

  for (const { spec, line } of importsOf(text)) {
    if (isMarketing) {
      // ── Rule 2: marketing imports the host narrowly ───────────────────────
      if (!spec.startsWith("@/")) continue; // package or relative path
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
      if (!MARKETING_ALIASES.some((a) => matchesAlias(spec, a))) continue;
      if (path === NAVBAR_EXCEPTION.file && spec === NAVBAR_EXCEPTION.spec) continue;
      violations.push({
        file: path,
        line,
        msg:
          `imports "${spec}" from outside marketing — marketing is a closed section, so nothing ` +
          `depends on it (the sole exception is ${NAVBAR_EXCEPTION.file} importing ` +
          `"${NAVBAR_EXCEPTION.spec}" to render the sidebar).`,
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
