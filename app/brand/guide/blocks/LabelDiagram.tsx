import type { BrandCanon } from "@/lib/brand/canon.types";

type ChassisElement = NonNullable<BrandCanon["labelChassis"]>["elements"][number];

/**
 * The label chassis drawn as a label, not described as a list: a schematic can
 * wrap — front text panel, bordered art window, fine-print band — with each
 * fixed zone carrying the number of the element card that specifies it.
 *
 * Everything here is placeholder except the geometry and the wordmark, which
 * renders the actual uploaded artwork when one is approved. "Illustrative
 * Name" stands where a release's name will; the art window holds only the one
 * gradient the illustration law permits (sky). That's the point of the
 * diagram: the chassis is what remains when a specific release is removed.
 *
 * Zones pair with elements by position in the canonical order the canon states
 * them. The first four positions are frozen at their pre-expansion meaning —
 * wordmark, art window, illustrative name (né title slot), chop — so a canon
 * published before the list grew still badges its four correctly; the newer
 * zones simply go unbadged until the longer list is published. Each element's
 * `n` is the number printed in its badge, kept in left-to-right,
 * top-to-bottom reading order — independent of storage position, since the
 * first four positions can't move. An element added beyond the twelfth gets a
 * spec card but no badge, because a new zone's geometry can't be inferred
 * from prose; extending the drawing is a deliberate code change.
 *
 * Colors and faces are the brand token utilities, so the diagram follows the
 * published canon rather than freezing today's hexes — but inside the
 * `brand-print` scope (lib/brand/tokens.ts), which pins the light palette in
 * both app themes: a label is ink on Paper whatever the screen around it is
 * doing, and the uploaded wordmark artwork carries fixed colors that only the
 * light palette can sit behind. The one background the tokens don't decide is
 * the label's own: it defaults to Paper, but the seasonal-colors element (12)
 * reserves the right for a season to recolor it — the diagram documents that
 * value rather than tracking the active season live.
 */
export default function LabelDiagram({
  elements,
  wordmarkUrl,
}: {
  elements: ChassisElement[];
  wordmarkUrl?: string | null;
}) {
  const [
    wordmark,
    artWindow,
    illustrativeName,
    chop,
    beerStyle,
    seasonEpisode,
    storyLine,
    artistCredit,
    additionalLogos,
    barcode,
    seasonal,
    warningText,
  ] = elements;

  return (
    <figure className="max-w-3xl">
      <div className="brand-print relative flex aspect-[8/5] w-full overflow-hidden rounded-lg border border-brand-line bg-brand-canvas shadow-sm">
        {/* Seasonal colors — the value is the whole label's ground, so its pin
            sits on the frame itself rather than inside any one zone. */}
        <Badge element={seasonal} className="bottom-2 left-2" />

        {/* ── Front text panel ── */}
        <div className="relative flex w-[30%] shrink-0 flex-col px-[4%] py-[5%]">
          {/* Wordmark band — the uploaded artwork itself; typed stand-in only
              until a wordmark is approved, so the band never renders empty. */}
          <div className="relative">
            <Badge element={wordmark} className="-top-2 -left-2" />
            {wordmarkUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- session-gated brand asset from the proxy route
              <img src={wordmarkUrl} alt="Wordmark" className="w-full" />
            ) : (
              <>
                <p className="font-brand-wordmark text-base uppercase tracking-[0.3em] text-brand-primary sm:text-xl">
                  Joho
                </p>
                <p className="mt-1 font-brand-wordmark text-2xs uppercase tracking-[0.25em] text-brand-primary sm:text-xs">
                  Brewing&nbsp;Co.
                </p>
              </>
            )}
          </div>

          {/* Illustrative name — the release's name alone, in the display face. */}
          <div className="relative mt-[16%]">
            <Badge element={illustrativeName} className="-top-2 -left-2" />
            <p className="font-brand-display text-lg uppercase leading-snug text-brand-primary sm:text-2xl">
              Illustrative
              <br />
              Name
            </p>
          </div>

          {/* Beer style name — the plain style, under the rule line. */}
          <div className="relative mt-[8%] border-t border-brand-primary pt-[7%]">
            <Badge element={beerStyle} className="-top-2 -left-2" />
            <p className="font-brand-body text-2xs font-bold uppercase tracking-[0.2em] text-brand-primary">
              Beer Style Name
            </p>
          </div>
          <p className="mt-[7%] font-brand-body text-2xs text-brand-content-muted">
            5.2% ABV / 16 FL. OZ.
          </p>

          {/* The chop — Seal Red, bottom center of the panel, per its spec
              sheet. The glyph rotates per motif family, so the seal is drawn
              empty. The season/episode mark sits directly beneath it. */}
          <div className="relative mt-auto flex flex-col items-center pt-[8%]">
            <div className="relative w-[24%]">
              <Badge element={chop} className="-left-7 top-1/2 -translate-y-1/2" />
              <div className="aspect-square w-full rounded-[2px] bg-brand-accent ring-2 ring-inset ring-brand-on-accent/40" />
            </div>
            <div className="relative mt-[5%]">
              <Badge element={seasonEpisode} className="-left-7 top-1/2 -translate-y-1/2" />
              <p className="font-brand-body text-2xs uppercase tracking-[0.2em] text-brand-content-muted">
                S#&nbsp;|&nbsp;E#
              </p>
            </div>
          </div>
        </div>

        {/* ── Bordered art window — the Paper margin is the parent's padding. ── */}
        <div className="relative min-w-0 flex-1 p-[2.5%]">
          <div className="relative h-full w-full overflow-hidden rounded-[2px] border border-brand-line-strong bg-gradient-to-b from-brand-primary via-brand-secondary to-brand-canvas">
            <Badge element={artWindow} className="-left-2 -top-2" />
            <p className="absolute inset-x-0 top-[38%] text-center font-brand-body text-2xs uppercase tracking-[0.2em] text-brand-canvas/90">
              The illustration roams here
            </p>
            {/* The gradient lands on canvas down here, so the credit and story
                take the muted on-canvas ink — canvas-colored text would vanish
                into it. Story line sits on top and runs narrow deliberately:
                a story line can run long, and stacking up to four short lines
                reads better than one wide line the art window can't spare the
                width for. */}
            <div className="absolute bottom-[4%] left-[4%] right-[4%]">
              <div className="relative w-fit max-w-[55%]">
                <Badge element={storyLine} className="-left-6 top-1/2 -translate-y-1/2" />
                <p className="font-brand-body text-2xs uppercase leading-snug tracking-wide text-brand-content-muted">
                  The story line, one or two sentences.
                </p>
              </div>
              <div className="relative mt-1.5">
                <Badge element={artistCredit} className="-left-6 top-1/2 -translate-y-1/2" />
                <p className="font-brand-body text-xs font-bold uppercase tracking-wide text-brand-content-muted">
                  Art by the Artist
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ── Fine-print band — contacts and legal, rotated as printed, every
            line flush to the top; the band's foot is reserved for the logo
            block and the barcode. ── */}
        <div className="flex w-[15%] shrink-0 flex-col border-l border-brand-line px-[1.5%] py-[2.5%]">
          <div className="relative flex min-h-0 flex-1 flex-row-reverse items-start justify-center gap-[14%]">
            <Badge element={warningText} className="-top-2 right-0" />
            {/* rotate-180 on top of vertical-rl, not vertical-rl alone: mixed
                orientation alone reads top-to-bottom (tilt your head right to
                read it upright); the 180 flips that so the correct reading
                order runs bottom-to-top instead, as printed. DOM order is
                reversed by flex-row-reverse, so the last line here renders
                leftmost: johobrewing.com first, government warning last. */}
            <p className="max-h-full rotate-180 truncate font-brand-body text-2xs text-brand-content-muted [writing-mode:vertical-rl]">
              Government warning — required legal text
            </p>
            <p className="max-h-full rotate-180 truncate font-brand-body text-2xs text-brand-content-muted [writing-mode:vertical-rl]">
              Brewed and canned by Terrier Point Brewing LLC
            </p>
            <p className="max-h-full rotate-180 truncate font-brand-body text-2xs font-bold uppercase tracking-[0.18em] text-brand-primary [writing-mode:vertical-rl]">
              johobrewing.com&nbsp;|&nbsp;@johobrewing
            </p>
          </div>
          <div className="relative mt-[12%] flex aspect-[4/3] items-center justify-center rounded-[2px] border border-dashed border-brand-line-strong">
            <Badge element={additionalLogos} className="-top-2 right-0" />
            <p className="px-1 text-center font-brand-body text-2xs uppercase leading-tight text-brand-content-muted">
              Logos &amp; emblems
            </p>
          </div>
          <div className="relative mt-[8%] flex aspect-[4/3] items-center justify-center rounded-[2px] border border-brand-line-strong">
            <Badge element={barcode} className="-top-2 right-0" />
            <p className="px-1 text-center font-brand-body text-2xs uppercase leading-tight text-brand-content-muted">
              Barcode
            </p>
          </div>
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
