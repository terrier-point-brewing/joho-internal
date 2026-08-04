import type { BrandCanon, FontRole } from "@/lib/brand/canon.types";
import { sourceOf } from "@/lib/brand/fontRegistry";
import { cssSize } from "@/lib/brand/typeSpecimen";
import SubHead from "./blocks/SubHead";

const FONT_CLASS: Record<FontRole, string> = {
  display: "font-brand-display",
  body: "font-brand-body",
  wordmark: "font-brand-wordmark",
  script: "font-brand-script",
};

const SOURCE_LABEL = {
  bundled: "Bundled",
  uploaded: "Uploaded",
  system: "System",
} as const;

const MEDIA: { key: string; title: string }[] = [
  { key: "screen", title: "On screen" },
  { key: "print", title: "In print" },
  { key: "packaging", title: "On packaging" },
  { key: "signage", title: "On signage" },
];

/**
 * Typography view: the faces, then where each one is used.
 *
 * Type used to be one run-on line per role — `display · Marcellus · weights
 * 400 · <note>` — above a specimen at a single arbitrary size. That said
 * nothing about where a face belongs or how large it should be, which is most
 * of what a type spec is for.
 *
 * Use-case rows render their specimen at their OWN stated size and weight, so
 * "48pt poster title" is something you see rather than a claim you take on
 * trust.
 */
export default function TypeView({ canon }: { canon: BrandCanon }) {
  const fontByRole = new Map(canon.fonts.map((f) => [f.role, f]));
  const useCases = canon.typeUseCases ?? [];

  const groups = MEDIA.map((medium) => ({
    ...medium,
    rows: useCases.filter((u) => u.medium === medium.key),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      <section className="mb-8">
        <SubHead
          title="Faces"
          description="The typefaces the brand is set in, and where each one comes from."
        />
        <div className="grid gap-3 sm:grid-cols-2">
          {canon.fonts.map((font) => (
            <div key={font.role} className="rounded-lg border border-brand-line p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-brand-body text-sm font-semibold text-brand-high-contrast">
                  {font.family}
                </p>
                <span className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted shrink-0">
                  {font.role} · {SOURCE_LABEL[sourceOf(font)]}
                </span>
              </div>

              <p className={`${FONT_CLASS[font.role]} text-3xl text-brand-high-contrast mt-2`}>
                {canon.brandName}
              </p>

              <div className="flex flex-wrap gap-1 mt-2">
                {font.weights.map((weight) => (
                  <span
                    key={weight}
                    className="font-brand-body text-2xs rounded border border-brand-line px-1.5 py-0.5 text-brand-content-muted"
                  >
                    {weight}
                  </span>
                ))}
              </div>

              {font.note && (
                <p className="font-brand-body text-xs text-brand-content-muted mt-2 leading-relaxed">
                  {font.note}
                </p>
              )}
              {font.license && (
                <p className="font-brand-body text-2xs text-brand-content-muted mt-1">
                  Licence: {font.license}
                </p>
              )}
            </div>
          ))}
        </div>
      </section>

      {groups.length > 0 && (
        <section>
          <SubHead
            title="Use cases"
            description="Every specimen below is rendered at its own stated size and weight."
          />
          <div className="rounded-lg border border-brand-line overflow-hidden">
            {groups.map((group) => (
              <div key={group.key}>
                <p className="font-brand-body text-2xs uppercase tracking-wide text-brand-content-muted bg-brand-surface px-3 py-1.5">
                  {group.title}
                </p>
                {group.rows.map((row, i) => {
                  const font = fontByRole.get(row.fontRole);
                  return (
                    <div
                      key={row.id ?? i}
                      className="grid gap-3 sm:grid-cols-[1fr_11rem] items-center px-3 py-3 border-t border-brand-line"
                    >
                      <span
                        className={`${FONT_CLASS[row.fontRole]} text-brand-high-contrast leading-tight`}
                        style={{
                          // The specimen IS the spec — rendered from this row's
                          // own values rather than one fixed preview size.
                          fontWeight: row.weight,
                          fontSize: cssSize(row.size),
                          letterSpacing: row.tracking,
                        }}
                      >
                        {row.element}
                      </span>
                      <span className="font-brand-body text-2xs text-brand-content-muted leading-relaxed">
                        {font?.family ?? row.fontRole} · {row.weight} · {row.size}
                        {row.tracking ? ` · ${row.tracking}` : ""}
                        {row.notes ? (
                          <>
                            <br />
                            {row.notes}
                          </>
                        ) : null}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  );
}
