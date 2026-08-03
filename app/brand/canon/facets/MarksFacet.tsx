"use client";

import type { BrandCanon } from "@/lib/brand/canon.types";
import { seedCanon } from "@/lib/brand/seedCanon";
import RuleListField from "../fields/RuleListField";
import ListField from "../fields/ListField";

type MarkSpec = NonNullable<BrandCanon["marks"]>[number];
type MarkVariant = MarkSpec["variants"][number];
type MarkKind = MarkSpec["kind"];
type Orientation = NonNullable<MarkVariant["orientation"]>;
type Spec = NonNullable<MarkSpec["specs"]>[number];

// No "logo": the guide's Marks tab shows wordmarks and chops only. A document
// that already holds a logo mark keeps it — see kindOptionsFor — rather than
// having its kind silently blanked by a select that can't represent it.
const KIND_OPTIONS: MarkKind[] = ["wordmark", "chop"];
const kindOptionsFor = (kind: MarkKind): MarkKind[] =>
  KIND_OPTIONS.includes(kind) ? KIND_OPTIONS : [...KIND_OPTIONS, kind];
const ORIENTATIONS: Orientation[] = ["horizontal", "vertical"];

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const pickerSafe = (hex: string) => (HEX_RE.test(hex) ? hex : "#000000");

const SUBLABEL = "text-2xs font-semibold uppercase tracking-wide text-muted";

/** Editable list of plain strings (summary / clearspace / one-rule lines). */
function StringList({
  label,
  items,
  placeholder,
  onChange,
}: {
  label: string;
  items: string[] | undefined;
  placeholder?: string;
  onChange: (next: string[]) => void;
}) {
  const list = items ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <span className={SUBLABEL}>{label}</span>
      {list.map((line, i) => (
        <div key={i} className="flex items-center gap-2">
          <input
            className="inp-sm flex-1"
            value={line}
            placeholder={placeholder}
            onChange={(e) => onChange(list.map((l, idx) => (idx === i ? e.target.value : l)))}
          />
          <button
            type="button"
            className="btn-danger shrink-0"
            onClick={() => onChange(list.filter((_, idx) => idx !== i))}
          >
            Remove
          </button>
        </div>
      ))}
      <button
        type="button"
        className="btn-secondary self-start"
        onClick={() => onChange([...list, ""])}
      >
        Add line
      </button>
    </div>
  );
}

/**
 * Structured editor for canon `marks` — the identity mark specification sheets
 * (wordmark/logo/chop). Edits the draft in place; Save/Publish are handled by
 * the shared canon publish bar. The mark artifacts (images) are uploaded
 * separately via the Assets-backed uploader on the same tab.
 */
export default function MarksFacet({
  draft,
  onChange,
}: {
  draft: BrandCanon;
  onChange: (next: BrandCanon) => void;
}) {
  const marks = draft.marks ?? [];

  const setMarks = (next: MarkSpec[]) => onChange({ ...draft, marks: next });
  const patchMark = (mi: number, patch: Partial<MarkSpec>) =>
    setMarks(marks.map((m, i) => (i === mi ? { ...m, ...patch } : m)));
  const patchVariant = (mi: number, vi: number, patch: Partial<MarkVariant>) =>
    patchMark(mi, {
      variants: marks[mi].variants.map((v, i) => (i === vi ? { ...v, ...patch } : v)),
    });

  function addMark() {
    setMarks([...marks, { kind: "wordmark", title: "", variants: [] }]);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
            Mark specifications
          </h3>
          <p className="text-xs text-muted mt-1">
            The spec sheets shown on this tab. Upload the artwork above; these are the written specs.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {marks.length === 0 && (seedCanon.marks?.length ?? 0) > 0 && (
            <button
              type="button"
              className="btn-secondary"
              onClick={() => setMarks(seedCanon.marks ?? [])}
            >
              Load seed spec
            </button>
          )}
          <button type="button" className="btn-secondary" onClick={addMark}>
            Add mark
          </button>
        </div>
      </div>

      {marks.length === 0 && (
        <p className="text-sm text-faint">
          No mark specs yet — add one, or load the seeded JOHO wordmark spec.
        </p>
      )}

      {marks.map((mark, mi) => (
        <div key={mi} className="flex flex-col gap-3 bg-surface-mid border border-line rounded-lg p-3">
          {/* Header fields */}
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className={SUBLABEL}>Kind</span>
              <select
                className="inp-sm"
                value={mark.kind}
                onChange={(e) => patchMark(mi, { kind: e.target.value as MarkKind })}
              >
                {kindOptionsFor(mark.kind).map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 flex-1 min-w-40">
              <span className={SUBLABEL}>Title</span>
              <input
                className="inp-sm"
                value={mark.title}
                placeholder="JOHO — two-cut J system"
                onChange={(e) => patchMark(mi, { title: e.target.value })}
              />
            </label>
            <button
              type="button"
              className="btn-danger"
              onClick={() => setMarks(marks.filter((_, i) => i !== mi))}
            >
              Remove mark
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <label className="flex flex-col gap-1">
              <span className={SUBLABEL}>Status</span>
              <input
                className="inp-sm"
                value={mark.status ?? ""}
                placeholder="Final specification"
                onChange={(e) => patchMark(mi, { status: e.target.value || undefined })}
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className={SUBLABEL}>Approved</span>
              <input
                className="inp-sm"
                value={mark.approved ?? ""}
                placeholder="Approved 22 Jul 2026"
                onChange={(e) => patchMark(mi, { approved: e.target.value || undefined })}
              />
            </label>
          </div>

          <StringList
            label="Header meta (right side)"
            items={mark.summary}
            placeholder="Horizontal 4a · Vertical 5e"
            onChange={(summary) => patchMark(mi, { summary: summary.length ? summary : undefined })}
          />

          {/* Usage rules — the same GuideRule primitive as Visual Identity, so
              a reader meets one pattern for "how to use this" across the guide. */}
          <RuleListField
            label="Usage"
            description="How this mark may and may not be used. Shown on every one of its cuts."
            rules={mark.usage}
            defaultPolarity="do"
            onChange={(usage) => patchMark(mi, { usage })}
          />

          {/* Variants */}
          <div className="flex flex-col gap-2">
            <span className={SUBLABEL}>Cuts / variants</span>
            {mark.variants.map((variant, vi) => (
              <div key={vi} className="flex flex-col gap-2 bg-surface border border-line rounded-md p-2">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex flex-col gap-1 flex-1 min-w-40">
                    <span className={SUBLABEL}>Code</span>
                    <input
                      className="inp-sm"
                      value={variant.code}
                      placeholder="Primary · Horizontal · 4A"
                      onChange={(e) => patchVariant(mi, vi, { code: e.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className={SUBLABEL}>Orientation</span>
                    <select
                      className="inp-sm"
                      value={variant.orientation ?? ""}
                      onChange={(e) =>
                        patchVariant(mi, vi, {
                          orientation: (e.target.value || undefined) as Orientation | undefined,
                        })
                      }
                    >
                      <option value="">—</option>
                      {ORIENTATIONS.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="btn-danger"
                    onClick={() =>
                      patchMark(mi, { variants: mark.variants.filter((_, i) => i !== vi) })
                    }
                  >
                    Remove cut
                  </button>
                </div>

                <label className="flex flex-col gap-1">
                  <span className={SUBLABEL}>Cut description</span>
                  <input
                    className="inp-sm"
                    value={variant.cut ?? ""}
                    placeholder="Descending-J display cut"
                    onChange={(e) => patchVariant(mi, vi, { cut: e.target.value || undefined })}
                  />
                </label>

                {/* Spec rows */}
                <div className="flex flex-col gap-1.5">
                  <span className={SUBLABEL}>Spec rows</span>
                  {variant.specs.map((row, ri) => (
                    <div key={ri} className="flex items-center gap-2">
                      <input
                        className="inp-sm w-28 shrink-0"
                        value={row.key}
                        placeholder="Typeface"
                        onChange={(e) =>
                          patchVariant(mi, vi, {
                            specs: variant.specs.map((r, idx) =>
                              idx === ri ? { ...r, key: e.target.value } : r,
                            ),
                          })
                        }
                      />
                      <input
                        className="inp-sm flex-1"
                        value={row.value}
                        placeholder="Marcellus, all caps"
                        onChange={(e) =>
                          patchVariant(mi, vi, {
                            specs: variant.specs.map((r, idx) =>
                              idx === ri ? { ...r, value: e.target.value } : r,
                            ),
                          })
                        }
                      />
                      <button
                        type="button"
                        className="btn-danger shrink-0"
                        onClick={() =>
                          patchVariant(mi, vi, {
                            specs: variant.specs.filter((_, idx) => idx !== ri),
                          })
                        }
                      >
                        Remove
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn-secondary self-start"
                    onClick={() =>
                      patchVariant(mi, vi, { specs: [...variant.specs, { key: "", value: "" }] })
                    }
                  >
                    Add row
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary self-start"
              onClick={() =>
                patchMark(mi, { variants: [...mark.variants, { code: "", specs: [] }] })
              }
            >
              Add cut
            </button>
          </div>

          {/* The mark's own spec sheet — the boundaries every cut is chosen
              within, shown on the guide as a single card (mirrors the chop's). */}
          <ListField<Spec>
            label="Specification"
            description="The rules every cut of this mark is chosen within — frame, orientation, valid color combinations. Shown on the guide as one card, same as the chop's."
            addLabel="Add spec row"
            items={mark.specs ?? []}
            onChange={(specs) => patchMark(mi, { specs })}
            blank={() => ({ key: "", value: "" })}
            renderItem={(spec, update) => (
              <div className="flex items-start gap-2">
                <input
                  className="inp-sm w-32 shrink-0"
                  value={spec.key}
                  onChange={(e) => update({ key: e.target.value })}
                  aria-label="Spec name"
                  placeholder="Frame"
                />
                <input
                  className="inp-sm flex-1"
                  value={spec.value}
                  onChange={(e) => update({ value: e.target.value })}
                  aria-label="Spec value"
                  placeholder="Square or rectangular, matched to where it sits"
                />
              </div>
            )}
          />

          {/* Colours */}
          <div className="flex flex-col gap-1.5">
            <span className={SUBLABEL}>Colours</span>
            {(mark.colors ?? []).map((c, ci) => (
              <div key={ci} className="flex items-center gap-2">
                <input
                  type="color"
                  value={pickerSafe(c.hex)}
                  onChange={(e) =>
                    patchMark(mi, {
                      colors: (mark.colors ?? []).map((x, idx) =>
                        idx === ci ? { ...x, hex: e.target.value } : x,
                      ),
                    })
                  }
                  className="h-8 w-8 shrink-0 rounded border border-line-strong bg-transparent cursor-pointer"
                  aria-label={`${c.name} color`}
                />
                <input
                  className="inp-sm flex-1"
                  value={c.name}
                  placeholder="Indigo"
                  onChange={(e) =>
                    patchMark(mi, {
                      colors: (mark.colors ?? []).map((x, idx) =>
                        idx === ci ? { ...x, name: e.target.value } : x,
                      ),
                    })
                  }
                />
                <input
                  className="inp-sm w-28"
                  value={c.hex}
                  placeholder="#26355D"
                  onChange={(e) =>
                    patchMark(mi, {
                      colors: (mark.colors ?? []).map((x, idx) =>
                        idx === ci ? { ...x, hex: e.target.value } : x,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="btn-danger shrink-0"
                  onClick={() =>
                    patchMark(mi, { colors: (mark.colors ?? []).filter((_, idx) => idx !== ci) })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <button
              type="button"
              className="btn-secondary self-start"
              onClick={() =>
                patchMark(mi, { colors: [...(mark.colors ?? []), { name: "", hex: "#000000" }] })
              }
            >
              Add colour
            </button>
          </div>

          <StringList
            label="Clearspace & scale"
            items={mark.clearspace}
            onChange={(clearspace) =>
              patchMark(mi, { clearspace: clearspace.length ? clearspace : undefined })
            }
          />
          <StringList
            label="The one rule"
            items={mark.oneRule}
            onChange={(oneRule) => patchMark(mi, { oneRule: oneRule.length ? oneRule : undefined })}
          />

          <label className="flex flex-col gap-1">
            <span className={SUBLABEL}>Footer note</span>
            <textarea
              className="inp font-mono text-xs min-h-16"
              value={mark.note ?? ""}
              onChange={(e) => patchMark(mi, { note: e.target.value || undefined })}
            />
          </label>
        </div>
      ))}
    </div>
  );
}
