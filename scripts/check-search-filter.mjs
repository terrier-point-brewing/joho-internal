#!/usr/bin/env node
// Search/filter/sort standard guard. Warn-only unless --strict.
// See docs/UI_STANDARD.md and docs/superpowers/specs/2026-07-09-search-filter-standards-design.md
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIR = join(ROOT, "app");
const EXCLUDE = [join("app", "components", "ui")]; // the sanctioned home for primitives
const STRICT = process.argv.includes("--strict");

const RULES = [
  { re: /type=["']search["']/, msg: 'raw <input type="search"> — use <SearchInput> from app/components/ui' },
  { re: /\.toLowerCase\(\)\.includes\(/, msg: "inline .toLowerCase().includes() filter — use useTableControls/applyControls" },
  { re: /function\s+SortTh\b/, msg: "local SortTh — use <SortableTh> from app/components/ui" },
  { re: /(?:function|const)\s+FilterChips\b/, msg: "local FilterChips — use <FilterChips> from app/components/ui" },
];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(ROOT, full);
    if (EXCLUDE.some((e) => rel.startsWith(e))) continue;
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of walk(SCAN_DIR)) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        violations.push({ file: relative(ROOT, file), line: i + 1, msg: rule.msg });
      }
    }
  });
}

if (violations.length === 0) {
  console.log("✓ search/filter/sort standard: no violations");
  process.exit(0);
}

const tag = STRICT ? "ERROR" : "WARN";
for (const v of violations) {
  console.log(`${tag} ${v.file}:${v.line} — ${v.msg}`);
}
console.log(`\n${violations.length} violation(s). ${STRICT ? "Failing (strict)." : "Warn-only during the retrofit sweep (PR 1–4)."}`);
process.exit(STRICT ? 1 : 0);
