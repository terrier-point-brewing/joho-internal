/**
 * `validate` is the only part of a plugin a person sees before anything is
 * posted, so these tests care about two things equally: that the right entries
 * are refused, and that the refusal is a sentence somebody can act on.
 *
 * It also has to be genuinely synchronous and genuinely pure — Compose runs it
 * on every keystroke — which is asserted rather than assumed.
 */
import { describe, it, expect } from "vitest";

import {
  INSTAGRAM_CAPTION_LIMIT,
  INSTAGRAM_CAROUSEL_MAX,
  INSTAGRAM_HASHTAG_LIMIT,
  countHashtags,
  validateInstagram,
} from "./validate";
import type { Entry, Media } from "../types";

function anEntry(over: Partial<Entry> = {}): Entry {
  return {
    id: "entry-1",
    kind: "post",
    startsAt: "2026-09-01T15:00:00.000Z",
    endsAt: null,
    caption: "Fresh cans of Epic Hazy, Friday at four.",
    details: {},
    status: "approved",
    origin: "manual",
    tags: ["cans"],
    ...over,
  };
}

function anImage(over: Partial<Media> = {}): Media {
  return {
    id: "media-1",
    type: "image",
    url: "https://bucket.invalid/marketing-media/2026/09/abc.jpg",
    width: 1080,
    height: 1080,
    durationS: null,
    bytes: 240_000,
    ...over,
  };
}

/** The reasons, or an empty array when it passed. Every assertion below reads one. */
function reasons(entry: Entry, media: Media[]): string[] {
  const result = validateInstagram(entry, media);
  return result.ok ? [] : result.reasons;
}

describe("instagram validate — what it accepts", () => {
  it("accepts a square JPEG with a short caption", () => {
    expect(validateInstagram(anEntry(), [anImage()])).toEqual({ ok: true });
  });

  it("accepts a carousel of the maximum size", () => {
    const media = Array.from({ length: INSTAGRAM_CAROUSEL_MAX }, (_, i) => anImage({ id: `m-${i}` }));
    expect(validateInstagram(anEntry(), media)).toEqual({ ok: true });
  });

  it("accepts a single image rather than demanding a second one for a carousel", () => {
    // Instagram's carousel minimum is two, but one image is a post, not an
    // undersized carousel. Nobody should be told to add an image.
    expect(validateInstagram(anEntry(), [anImage()])).toEqual({ ok: true });
  });

  it("accepts .jpeg as well as .jpg", () => {
    expect(validateInstagram(anEntry(), [anImage({ url: "https://b.invalid/a.jpeg" })])).toEqual({ ok: true });
  });

  it("accepts an image whose dimensions were never measured", () => {
    // Nullable dimensions are "not measured", not "wrong". Refusing on a null
    // would be a channel a person cannot use and cannot fix.
    expect(validateInstagram(anEntry(), [anImage({ width: null, height: null })])).toEqual({ ok: true });
  });

  it("accepts both ends of the aspect range", () => {
    const portrait = anImage({ width: 1080, height: 1350 }); // 4:5 exactly
    const landscape = anImage({ width: 1910, height: 1000 }); // 1.91:1 exactly
    expect(validateInstagram(anEntry(), [portrait])).toEqual({ ok: true });
    expect(validateInstagram(anEntry(), [landscape])).toEqual({ ok: true });
  });

  it("accepts a caption at exactly the limit", () => {
    expect(validateInstagram(anEntry({ caption: "x".repeat(INSTAGRAM_CAPTION_LIMIT) }), [anImage()])).toEqual({
      ok: true,
    });
  });

  it("accepts a URL carrying a query string after the extension", () => {
    expect(validateInstagram(anEntry(), [anImage({ url: "https://b.invalid/a.jpg?token=1" })])).toEqual({ ok: true });
  });
});

describe("instagram validate — what it refuses, and how it says so", () => {
  it("refuses an entry with no media", () => {
    expect(reasons(anEntry(), [])).toEqual(["An Instagram post needs at least one image. A caption on its own cannot be posted."]);
  });

  it("refuses a carousel of eleven and says how many to remove", () => {
    const media = Array.from({ length: 11 }, (_, i) => anImage({ id: `m-${i}` }));
    expect(reasons(anEntry(), media)).toEqual([
      "A carousel holds at most 10 images and this entry has 11. Remove 1.",
    ]);
  });

  it("refuses a reel, because the app publishes no video at all", () => {
    const said = reasons(anEntry({ kind: "reel" }), [anImage()]);
    expect(said).toHaveLength(1);
    expect(said[0]).toMatch(/video/);
  });

  it("refuses a story and a boost, each in its own words", () => {
    expect(reasons(anEntry({ kind: "story" }), [anImage()])[0]).toMatch(/stories/);
    expect(reasons(anEntry({ kind: "boost" }), [anImage()])[0]).toMatch(/spend/);
  });

  it("refuses a kind it has never heard of", () => {
    expect(reasons(anEntry({ kind: "skywriting" }), [anImage()])[0]).toContain('"skywriting"');
  });

  it("refuses a video even when the entry kind is a post", () => {
    const said = reasons(anEntry(), [anImage({ type: "video", url: "https://b.invalid/a.mp4", durationS: 20 })]);
    expect(said).toEqual(["a.mp4 is a video, and this app cannot publish video to Instagram yet."]);
  });

  it("refuses a PNG and names the file and the format", () => {
    const said = reasons(anEntry(), [anImage({ url: "https://b.invalid/label.png" })]);
    expect(said).toEqual(["label.png is a .png file. Instagram only accepts JPEG images — re-export it as a .jpg."]);
  });

  it("refuses a file with no extension at all", () => {
    expect(reasons(anEntry(), [anImage({ url: "https://b.invalid/label" })])[0]).toMatch(/no file extension/);
  });

  it("refuses an image over Instagram's size ceiling, in megabytes", () => {
    const said = reasons(anEntry(), [anImage({ bytes: 9 * 1024 * 1024 })]);
    expect(said).toEqual(["abc.jpg is 9.0 MB. Instagram's limit for a feed image is 8.0 MB."]);
  });

  it("refuses a too-tall image and shows the ratio it computed", () => {
    const said = reasons(anEntry(), [anImage({ width: 1080, height: 1920 })]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("1080×1920");
    expect(said[0]).toContain("0.56:1");
    expect(said[0]).toContain("1.91:1");
  });

  it("refuses a too-wide image", () => {
    expect(reasons(anEntry(), [anImage({ width: 2000, height: 1000 })])[0]).toContain("2.00:1");
  });

  it("names which image in a carousel is at fault", () => {
    const said = reasons(anEntry(), [anImage(), anImage({ id: "m2", url: "https://b.invalid/two.png" })]);
    expect(said).toEqual(["Image 2 (two.png) is a .png file. Instagram only accepts JPEG images — re-export it as a .jpg."]);
  });

  it("refuses an over-long caption with both numbers grouped", () => {
    const said = reasons(anEntry({ caption: "x".repeat(2431) }), [anImage()]);
    expect(said).toEqual(["This caption is 2,431 characters. Instagram's limit is 2,200."]);
  });

  it("refuses more than thirty hashtags", () => {
    const caption = Array.from({ length: 31 }, (_, i) => `#tag${i}`).join(" ");
    expect(reasons(anEntry({ caption }), [anImage()])).toEqual([
      "This caption has 31 hashtags. Instagram allows 30 on a post.",
    ]);
  });

  it("accepts exactly thirty hashtags", () => {
    const caption = Array.from({ length: INSTAGRAM_HASHTAG_LIMIT }, (_, i) => `#tag${i}`).join(" ");
    expect(validateInstagram(anEntry({ caption }), [anImage()])).toEqual({ ok: true });
  });

  it("reports every problem at once rather than one trip at a time", () => {
    const said = reasons(anEntry({ kind: "reel", caption: "x".repeat(3000) }), [
      anImage({ url: "https://b.invalid/a.png", width: 100, height: 900 }),
    ]);
    expect(said.length).toBeGreaterThanOrEqual(4);
  });

  it("writes sentences, not codes", () => {
    const said = reasons(anEntry({ kind: "reel", caption: "x".repeat(3000) }), []);
    for (const reason of said) {
      expect(reason).toMatch(/[.!?]$/);
      expect(reason).not.toMatch(/^[A-Z_]+$/);
    }
  });
});

describe("counting hashtags", () => {
  it("counts adjacent tags separately", () => {
    expect(countHashtags("#one#two #three")).toBe(3);
  });

  it("ignores a bare hash and a hash inside a word", () => {
    expect(countHashtags("issue no#5 and a lone # here")).toBe(0);
  });

  it("counts non-ASCII tags", () => {
    expect(countHashtags("#bière #hazy")).toBe(2);
  });

  it("counts nothing in an empty caption", () => {
    expect(countHashtags("")).toBe(0);
  });
});

describe("instagram validate — the contract's own rules", () => {
  it("is synchronous: it returns a result, never a promise", () => {
    const result = validateInstagram(anEntry(), [anImage()]);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("is pure: the same input twice gives the same answer", () => {
    const entry = anEntry({ caption: "x".repeat(3000) });
    expect(validateInstagram(entry, [anImage()])).toEqual(validateInstagram(entry, [anImage()]));
  });
});
