import type { BrandCanon } from "./canon.types";
import { SECTION_KEYS } from "./canonSections";
import { GUIDE_SECTIONS, type GuideSectionKey } from "./guideIntros";

/**
 * Pure canon diff — the engine behind auto-generated changelogs.
 *
 * The one rule that matters: **list items are matched by `id`, never by array
 * index.** Index matching would report a reorder as N removals plus N additions
 * and a rename as a removal plus an addition, which is exactly the unreadable
 * output that made hand-written changelogs feel necessary in the first place.
 */

export interface ChangeEntry {
  section: GuideSectionKey | "other";
  kind: "added" | "removed" | "changed";
  /** A human sentence — "Seal Red hex #ad1a2d → #a51829". */
  label: string;
  /** Machine-readable location — "palette.seal-red.hex". */
  path: string;
  before?: string;
  after?: string;
}

const SECTION_TITLES: Record<GuideSectionKey, string> = {
  ethos: "Ethos",
  voice: "Voice",
  visual: "Visual Identity",
  color: "Color",
  type: "Type",
  marks: "Marks",
  release: "Release Design",
  agent: "Agent Rules",
};

// The field to call an item by in a changelog line, most specific first. A
// palette color is "Seal Red", a value is its title, a font is its role.
//
// Order matters: `name` sits ahead of `role` because a palette color has both,
// and its `role` holds a long use-case sentence rather than a short label. A
// font has no name, so it falls through to `role` and reads as "display".
const DISPLAY_FIELDS = ["title", "name", "role", "family", "code", "context", "left"] as const;

// Longest a value may be before a changelog line truncates it. Intro prose runs
// to whole paragraphs; a changelog is an index, not a diff viewer.
const MAX_VALUE = 60;

type Unknown = Record<string, unknown>;

function isObject(v: unknown): v is Unknown {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** How a changelog refers to one list item. Falls back to its id. */
function displayName(item: Unknown): string {
  for (const field of DISPLAY_FIELDS) {
    const value = item[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return typeof item.id === "string" ? item.id : "item";
}

/** Renders a leaf value compactly enough to sit in a one-line label. */
function short(value: unknown): string {
  if (value === undefined) return "—";
  if (typeof value === "string") {
    return value.length > MAX_VALUE ? `${value.slice(0, MAX_VALUE).trimEnd()}…` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  return "…";
}

/** True for an array of plain scalars — a string list with no per-item identity. */
function isScalarList(value: unknown): value is (string | number)[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string" || typeof v === "number");
}

/**
 * String lists (neverList, hardRules, colorForbidden, …) have no stable id per
 * element, but reporting "10 items → 11 items" tells a reader nothing. Diff them
 * by value instead: an element present in one side and not the other is an
 * addition or a removal, and that IS the useful sentence.
 */
function compareScalarLists(
  prev: (string | number)[],
  next: (string | number)[],
  path: string,
  ctx: Ctx,
): void {
  const prevSet = new Set(prev.map(String));
  const nextSet = new Set(next.map(String));
  const field = path.split(".").pop() ?? path;

  for (const item of next) {
    if (prevSet.has(String(item))) continue;
    ctx.out.push({
      section: ctx.section,
      kind: "added",
      label: `added to ${field}: ${short(item)}`,
      path: `${path}[${item}]`,
      after: short(item),
    });
  }
  for (const item of prev) {
    if (nextSet.has(String(item))) continue;
    ctx.out.push({
      section: ctx.section,
      kind: "removed",
      label: `removed from ${field}: ${short(item)}`,
      path: `${path}[${item}]`,
      before: short(item),
    });
  }
}

/** True when a list holds objects carrying ids — the id-matched case. */
function isIdentifiedList(value: unknown): value is Unknown[] {
  return Array.isArray(value) && value.every((v) => isObject(v) && typeof v.id === "string");
}

interface Ctx {
  section: GuideSectionKey | "other";
  out: ChangeEntry[];
}

function compareIdentifiedLists(prev: Unknown[], next: Unknown[], path: string, ctx: Ctx): void {
  const prevById = new Map(prev.map((item) => [item.id as string, item]));
  const nextById = new Map(next.map((item) => [item.id as string, item]));

  // Added / changed, walked in `next` order so output follows the document.
  for (const [id, item] of nextById) {
    const before = prevById.get(id);
    if (!before) {
      ctx.out.push({
        section: ctx.section,
        kind: "added",
        label: `added ${displayName(item)}`,
        path: `${path}.${id}`,
      });
      continue;
    }
    // Name the item by what it was called BEFORE the edit — otherwise a rename
    // reads as the nonsensical "Chop Red name: Seal Red → Chop Red".
    compareValues(before, item, `${path}.${id}`, ctx, displayName(before));
  }

  for (const [id, item] of prevById) {
    if (nextById.has(id)) continue;
    ctx.out.push({
      section: ctx.section,
      kind: "removed",
      label: `removed ${displayName(item)}`,
      path: `${path}.${id}`,
    });
  }
}

/**
 * Recursive structural compare. `owner` is the display name of the nearest
 * enclosing list item, so a leaf change reads "Seal Red hex …" rather than
 * "palette.3f2a.hex …".
 */
function compareValues(
  prev: unknown,
  next: unknown,
  path: string,
  ctx: Ctx,
  owner?: string,
): void {
  if (isIdentifiedList(prev) && isIdentifiedList(next)) {
    compareIdentifiedLists(prev, next, path, ctx);
    return;
  }

  if (isScalarList(prev) && isScalarList(next)) {
    compareScalarLists(prev, next, path, ctx);
    return;
  }

  if (isObject(prev) && isObject(next)) {
    for (const key of new Set([...Object.keys(prev), ...Object.keys(next)])) {
      if (key === "id") continue; // identity, not content
      compareValues(prev[key], next[key], `${path}.${key}`, ctx, owner);
    }
    return;
  }

  // Everything else — scalars, and arrays of plain strings/numbers — compares
  // by value. A string list has no stable identity per element, so a whole-list
  // replacement is the honest unit of change.
  if (JSON.stringify(prev) === JSON.stringify(next)) return;

  const field = path.split(".").pop() ?? path;

  // The subtab introductions are whole paragraphs; quoting both sides would
  // bury every other entry. Name the change, not its contents.
  if (path.startsWith("guideIntros.")) {
    ctx.out.push({
      section: ctx.section,
      kind: prev === undefined ? "added" : "changed",
      label: prev === undefined ? "introduction added" : "introduction rewritten",
      path,
      before: short(prev),
      after: short(next),
    });
    return;
  }

  const label = owner
    ? `${owner} ${field}: ${short(prev)} → ${short(next)}`
    : `${field}: ${short(prev)} → ${short(next)}`;

  ctx.out.push({
    section: ctx.section,
    kind: "changed",
    label,
    path,
    before: short(prev),
    after: short(next),
  });
}

export function diffCanon(prev: BrandCanon | null, next: BrandCanon): ChangeEntry[] {
  const out: ChangeEntry[] = [];

  // First publish: one entry per populated section rather than an entry for
  // every field in the document, which would be noise nobody reads.
  if (prev === null) {
    for (const section of GUIDE_SECTIONS) {
      const populated = SECTION_KEYS[section].some((key) => {
        const value = next[key];
        return Array.isArray(value) ? value.length > 0 : value !== undefined;
      });
      if (!populated) continue;
      out.push({
        section,
        kind: "added",
        label: `${SECTION_TITLES[section]} published for the first time`,
        path: section,
      });
    }
    return out;
  }

  for (const section of GUIDE_SECTIONS) {
    for (const key of SECTION_KEYS[section]) {
      compareValues(prev[key], next[key], key, { section, out });
    }
  }

  // guideIntros belongs to every subtab — each key is attributed to its own.
  for (const section of GUIDE_SECTIONS) {
    compareValues(
      prev.guideIntros?.[section],
      next.guideIntros?.[section],
      `guideIntros.${section}`,
      { section, out },
    );
  }

  return out;
}

/** Markdown changelog, grouped by subtab. Deterministic for a given input. */
export function renderChangelog(entries: ChangeEntry[]): string {
  if (entries.length === 0) return "";

  const order: (GuideSectionKey | "other")[] = [...GUIDE_SECTIONS, "other"];
  const lines: string[] = [];

  for (const section of order) {
    const group = entries.filter((e) => e.section === section);
    if (group.length === 0) continue;

    const title = section === "other" ? "Other" : SECTION_TITLES[section];
    lines.push(`## ${title}`);
    for (const entry of [...group].sort((a, b) => a.path.localeCompare(b.path))) {
      lines.push(`- ${entry.label}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
