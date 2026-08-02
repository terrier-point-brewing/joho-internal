import type { BrandCanon, RoleName } from "@/lib/brand/canon.types";
import CopyChip from "./CopyChip";

type BrandColor = BrandCanon["palette"][number];

/** hex → "R G B", for the code chips. */
function toRgb(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r} ${g} ${b}`;
}

/**
 * One palette color and everything a person needs to use it.
 *
 * The use case is body text rather than metadata — it's the line that tells you
 * when to reach for this color, which makes it the most useful thing on the
 * card. The `key` is shown as a small mono chip because it's a technical
 * identifier the theme binds to, not a name.
 *
 * `Drives:` is the palette side of the palette↔theme link: edit this hex and
 * every role listed follows.
 */
export default function SwatchCard({
  color,
  drives,
}: {
  color: BrandColor;
  drives: RoleName[];
}) {
  return (
    <div className="rounded-lg border border-brand-line overflow-hidden">
      <div className="h-16 border-b border-brand-line" style={{ background: color.hex }} />

      <div className="p-3">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
            {color.name}
          </p>
          <span className="font-mono text-2xs text-brand-content-muted">{color.key}</span>
        </div>

        {color.role && (
          <p className="font-brand-body text-xs text-brand-content mt-1 leading-relaxed">
            {color.role}
          </p>
        )}

        <div className="flex flex-wrap gap-1 mt-2.5">
          <CopyChip label="hex" value={color.hex.toUpperCase()} />
          <CopyChip label="rgb" value={toRgb(color.hex)} />
          {color.cmyk && <CopyChip label="cmyk" value={color.cmyk} />}
        </div>

        <p className="font-brand-body text-2xs text-brand-content-muted mt-2.5">
          {drives.length > 0 ? (
            <>
              Drives <span className="text-brand-accent">{drives.join(", ")}</span>
            </>
          ) : (
            "Not bound to any role"
          )}
        </p>
      </div>
    </div>
  );
}
