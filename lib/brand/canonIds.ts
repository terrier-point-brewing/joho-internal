import type { BrandCanon } from "./canon.types";

/**
 * Backfills stable `id`s onto every canon list item that lacks one.
 *
 * Pure and idempotent: an item that already has an id keeps it, and a second
 * pass over the result reports `changed: false`. That guarantee is load-bearing
 * — `getDraft` calls this on every read and persists only when `changed` is
 * true, so a non-idempotent implementation would rewrite the draft row forever.
 *
 * Ids are random, never derived from content. A content-derived id would change
 * when the content changes, which would make diffCanon report every edit as a
 * delete plus an add — precisely the behaviour ids exist to prevent.
 */

// One list to add ids to. `read` pulls the array off the canon (or undefined
// when the field is optional and absent); `write` puts the new array back.
interface ListSpec {
  read: (c: BrandCanon) => { id?: string }[] | undefined;
  write: (c: BrandCanon, next: { id?: string }[]) => void;
}

const LISTS: ListSpec[] = [
  {
    read: (c) => c.values,
    write: (c, next) => {
      c.values = next as BrandCanon["values"];
    },
  },
  {
    read: (c) => c.voice?.sliders,
    write: (c, next) => {
      c.voice.sliders = next as BrandCanon["voice"]["sliders"];
    },
  },
  {
    read: (c) => c.voice?.rewrites,
    write: (c, next) => {
      c.voice.rewrites = next as BrandCanon["voice"]["rewrites"];
    },
  },
  {
    read: (c) => c.palette,
    write: (c, next) => {
      c.palette = next as BrandCanon["palette"];
    },
  },
  {
    read: (c) => c.fonts,
    write: (c, next) => {
      c.fonts = next as BrandCanon["fonts"];
    },
  },
  {
    read: (c) => c.marks,
    write: (c, next) => {
      c.marks = next as BrandCanon["marks"];
    },
  },
  {
    read: (c) => c.illustrationLaw?.pairs,
    write: (c, next) => {
      c.illustrationLaw = {
        ...c.illustrationLaw,
        pairs: next as NonNullable<BrandCanon["illustrationLaw"]["pairs"]>,
      };
    },
  },
];

function assignIds(items: { id?: string }[]): { items: { id?: string }[]; changed: boolean } {
  let changed = false;
  const next = items.map((item) => {
    if (item.id) return item;
    changed = true;
    return { ...item, id: crypto.randomUUID() };
  });
  return { items: next, changed };
}

export function withIds(canon: BrandCanon): { canon: BrandCanon; changed: boolean } {
  // Structured clone keeps this pure — callers hand us a document they may still
  // be holding a reference to (the editor's in-progress draft, for one).
  const next = structuredClone(canon);
  let changed = false;

  for (const list of LISTS) {
    const items = list.read(next);
    if (!items) continue;
    const result = assignIds(items);
    if (result.changed) {
      list.write(next, result.items);
      changed = true;
    }
  }

  // Mark variants nest one level deeper, so they're walked separately rather
  // than being bent into the flat ListSpec shape above.
  for (const mark of next.marks ?? []) {
    const result = assignIds(mark.variants);
    if (result.changed) {
      mark.variants = result.items as typeof mark.variants;
      changed = true;
    }
  }

  return { canon: next, changed };
}
