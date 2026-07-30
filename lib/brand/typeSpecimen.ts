/**
 * Turns a canon size string into a CSS `font-size`, or nothing.
 *
 * Sizes are authored as free text because print and screen don't share units:
 * "32/38" is size/leading in px, "48pt" is print, "1.5rem" is neither. Parsing
 * the leading number and unit covers all three.
 *
 * Anything it can't read confidently returns `undefined` and the specimen falls
 * back to inherited sizing. That's deliberate: this value goes straight into an
 * inline style from an admin-entered field, so a typo like "320" must not be
 * able to render a 320px word across the page. A missing specimen size is a
 * cosmetic problem; an unbounded one is a broken page.
 */
export function cssSize(size: string): string | undefined {
  const match = size.trim().match(/^(\d+(?:\.\d+)?)\s*(px|pt|rem)?/i);
  if (!match) return undefined;

  const value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return undefined;

  const unit = (match[2] ?? "px").toLowerCase();
  // Upper bounds per unit, sized to "a large poster headline" and no larger.
  const max = unit === "rem" ? 12 : 200;
  if (value > max) return undefined;

  return `${value}${unit}`;
}
