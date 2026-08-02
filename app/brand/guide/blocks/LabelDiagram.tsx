import type { BrandCanon } from "@/lib/brand/canon.types";

type ChassisElement = NonNullable<BrandCanon["labelChassis"]>["elements"][number];

/**
 * The label chassis drawn as a label, not described as a list: a schematic can
 * wrap — front text panel, bordered art window, fine-print band — with each
 * fixed zone carrying the number of the element card that specifies it.
 *
 * Everything here is placeholder except the geometry. "Beer Name" stands where
 * a release's name will; the art window holds only the one gradient the
 * illustration law permits (sky). That's the point of the diagram: the chassis
 * is what remains when a specific release is removed.
 *
 * Zones pair with elements by position in the canonical order the canon states
 * them — wordmark band, art window, title slot, chop. An element added beyond
 * the fourth gets a spec card but no badge, because a new zone's geometry can't
 * be inferred from prose; extending the drawing is a deliberate code change.
 *
 * Colors and faces are the brand token utilities, so the diagram follows the
 * published canon (and its dark derivation) rather than freezing today's hexes.
 */
export default function LabelDiagram({ elements }: { elements: ChassisElement[] }) {
  const [wordmark, artWindow, titleSlot, chop] = elements;

  return (
    <figure className="max-w-3xl">
      <div className="relative flex aspect-[8/5] w-full overflow-hidden rounded-lg border border-brand-line bg-brand-canvas shadow-sm">
        {/* ── Front text panel ── */}
        <div className="relative flex w-[30%] shrink-0 flex-col px-[4%] py-[5%]">
          {/* Wordmark band — same asset, same position, top of the panel. */}
          <div className="relative">
            <Badge element={wordmark} className="-top-1 right-0" />
            <p className="font-brand-wordmark text-base uppercase tracking-[0.3em] text-brand-primary sm:text-xl">
              Joho
            </p>
            <p className="mt-1 font-brand-wordmark text-2xs uppercase tracking-[0.25em] text-brand-primary sm:text-xs">
              Brewing&nbsp;Co.
            </p>
          </div>

          {/* Title slot — name in the display face, style subtitle below. */}
          <div className="relative mt-[16%]">
            <Badge element={titleSlot} className="-top-1 right-0" />
            <p className="font-brand-display text-lg uppercase leading-snug text-brand-primary sm:text-2xl">
              Beer
              <br />
              Name
            </p>
            <div className="mt-[8%] border-t border-brand-primary pt-[7%]">
              <p className="font-brand-body text-2xs font-bold uppercase tracking-[0.2em] text-brand-primary">
                Style Subtitle
              </p>
            </div>
            <p className="mt-[7%] font-brand-body text-2xs text-brand-content-muted">
              5.2% ABV / 16 FL. OZ.
            </p>
          </div>
        </div>

        {/* ── Bordered art window — the Paper margin is the parent's padding. ── */}
        <div className="relative min-w-0 flex-1 p-[2.5%]">
          <div className="relative h-full w-full overflow-hidden rounded-[2px] border border-brand-line-strong bg-gradient-to-b from-brand-primary via-brand-secondary to-brand-canvas">
            <Badge element={artWindow} className="left-2 top-2" />
            <p className="absolute inset-x-0 top-[38%] text-center font-brand-body text-2xs uppercase tracking-[0.2em] text-brand-canvas/90">
              The illustration roams here
            </p>
            {/* The gradient lands on canvas down here, so the credit takes the
                muted on-canvas ink — canvas-colored text would vanish into it. */}
            <p className="absolute bottom-[4%] left-[4%] font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted">
              By the artist
            </p>

            {/* The chop — Seal Red, bottom-right, offset 4% of window width,
                height ~9% of window height, per its spec sheet. The glyph
                rotates per motif family, so the seal is drawn empty. */}
            <div className="absolute bottom-[4%] right-[4%] h-[9%]">
              <Badge element={chop} className="-left-7 top-1/2 -translate-y-1/2" />
              <div className="h-full rounded-[2px] bg-brand-accent ring-2 ring-inset ring-brand-on-accent/40 aspect-square" />
            </div>
          </div>
        </div>

        {/* ── Fine-print band — contacts and legal, rotated as printed. ── */}
        <div className="flex w-[15%] shrink-0 items-center justify-center gap-[14%] border-l border-brand-line px-[1.5%] py-[6%]">
          <p className="rotate-180 font-brand-body text-2xs font-bold uppercase tracking-[0.18em] text-brand-primary [writing-mode:vertical-rl]">
            johobrewing.com&nbsp;|&nbsp;@johobrewing
          </p>
          <p className="rotate-180 truncate font-brand-body text-2xs text-brand-content-muted [writing-mode:vertical-rl]">
            Brewed and canned by Terrier Point Brewing LLC
          </p>
        </div>
      </div>

      <figcaption className="mt-2 font-brand-body text-xs text-brand-content-muted">
        Schematic, not artwork — placeholders stand in for a release. The numbers are the
        elements below; those zones never move.
      </figcaption>
    </figure>
  );
}

/** The numbered pin tying a fixed zone to its element card. */
function Badge({ element, className }: { element?: ChassisElement; className: string }) {
  if (!element) return null;
  return (
    <span
      className={`absolute z-10 flex h-5 w-5 items-center justify-center rounded-full bg-brand-primary font-brand-body text-2xs font-bold text-brand-on-primary ring-2 ring-brand-canvas ${className}`}
    >
      {element.n}
    </span>
  );
}
