// The Brand Guide copy each Releases card quotes, resolved once from the
// published canon.
//
// ── WHY A RESOLVER AND NOT PROSE IN THE COMPONENTS ──────────────────────────
// The workbench used to reach into the canon twice by hand (the naming
// criteria, the chassis narrative) and hardcode everything else. Hardcoded
// guide copy is a second copy: the founder edits the guide, publishes, and the
// release workbench keeps saying the old thing. So the rule is that the
// components hold NO guide prose — this file is the one place that knows which
// canon slice belongs to which card, and the cards render whatever it hands
// them.
//
// Edits roll through on their own: getCanon() is cached under the
// `brand-canon` tag, app/api/brand/canon/publish/route.ts busts that tag on
// publish, and app/brand/releases/page.tsx renders per request. A canon edited
// directly by SQL migration instead of the UI lags by getCanon()'s 5-minute
// revalidate window, same as every other canon consumer.
//
// ── WHY ONLY TWO CARDS HAVE COPY ────────────────────────────────────────────
// The guide governs naming and the label chassis. It says nothing about
// linking a Production recipe or registering a product code, because those
// aren't brand decisions — they're Production facts. Rather than invent canon
// fields to fill the gap, those cards get an empty entry and keep their own
// operational instructions, plainly app-authored. If the guide ever grows a
// section about them, it gets mapped here and the card changes for free.
//
// Same resolver idiom as guideIntros.ts, including the `?? ""` defaults:
// getCanon() deliberately doesn't validate on read, so every field is treated
// as possibly absent.

import type { BrandCanon } from "./canon.types";
import type { ReleaseComponentKey } from "./releases";

export interface GuideRow {
  label: string;
  value: string;
}

/** The guide's say on one release component. Empty when the guide is silent. */
export interface ReleaseGuideEntry {
  /** Framing prose. */
  intro: string;
  /** Numbered rules — naming's five gates. */
  rules: string[];
  /** The guide's own labelled lines: template slots, chassis elements. */
  rows: GuideRow[];
  /** Set apart at the foot — the read-it-aloud test. */
  footer: string;
}

export type ReleaseGuide = Record<ReleaseComponentKey, ReleaseGuideEntry>;

const EMPTY: ReleaseGuideEntry = { intro: "", rules: [], rows: [], footer: "" };

/** Drops rows the canon hasn't filled in, rather than showing a bare label. */
function rows(...candidates: [string, string | undefined][]): GuideRow[] {
  return candidates.flatMap(([label, value]) => (value ? [{ label, value }] : []));
}

export function resolveReleaseGuide(canon: BrandCanon): ReleaseGuide {
  const narrative = canon.naming?.narrative;
  const chassis = canon.labelChassis;

  return {
    // Same four slots the guide's own "Writing a release card" template
    // renders (app/brand/guide/ReleaseView.tsx) — the card's fields and the
    // instructions for them, side by side.
    card: {
      intro: narrative?.intro ?? "",
      rules: canon.naming?.criteria ?? [],
      rows: rows(
        ["Name", narrative?.name],
        ["Story line", narrative?.story],
        ["Menu description", narrative?.menuDescription],
        ["Why it passes", narrative?.why],
      ),
      footer: narrative?.footer ?? "",
    },
    // Storage order pairs elements to the guide's diagram zones and can't be
    // reordered; `n` carries the reading order, so sort by it here too.
    label: {
      intro: chassis?.narrative ?? "",
      rules: [],
      rows: [...(chassis?.elements ?? [])]
        .sort((a, b) => Number(a.n) - Number(b.n))
        .map((element) => ({ label: `${element.n}. ${element.title}`, value: element.desc })),
      footer: "",
    },
    recipe: EMPTY,
    codes: EMPTY,
  };
}

/** True when the guide has nothing to say about a card — render just the link. */
export function isEmptyGuideEntry(entry: ReleaseGuideEntry | undefined): boolean {
  return !entry || (!entry.intro && entry.rules.length === 0 && entry.rows.length === 0);
}

/** The Brand Guide subtab this copy is quoted from. */
export const RELEASE_GUIDE_HREF = "/brand/guide?tab=release";
