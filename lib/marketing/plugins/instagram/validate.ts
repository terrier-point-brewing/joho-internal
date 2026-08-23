/**
 * What Instagram will refuse, decided without asking Instagram.
 *
 * This runs on **every keystroke** in Compose — that is why `validate` is
 * synchronous in the contract — so there is no I/O here, no clock and no
 * randomness. Everything is a function of the entry and its media.
 *
 * ── Every reason is a sentence, and it names the thing ──────────────────────
 * These strings are shown to a person beside a greyed-out channel and are the
 * only explanation they get. So "This caption is 2,431 characters. Instagram's
 * limit is 2,200." rather than "CAPTION_TOO_LONG", and where a rule is about
 * one particular image the reason says which one and what is wrong with it.
 * There is no layer between this string and somebody's eye.
 *
 * ── Why the rules are the ones they are ─────────────────────────────────────
 * Each limit below is Instagram's, not ours, with one exception noted at
 * {@link INSTAGRAM_MAX_IMAGE_BYTES}. Where a fact is simply unknown — an image
 * whose dimensions were never measured — the rule stays silent rather than
 * guessing. A `validate` that refuses on a null is a channel a person cannot
 * use and cannot fix.
 */
import type { Entry, Media, ValidationResult } from "../types";

/** Instagram's caption limit, in characters. */
export const INSTAGRAM_CAPTION_LIMIT = 2200;

/** Instagram's hashtag limit for a single post. */
export const INSTAGRAM_HASHTAG_LIMIT = 30;

/** "A comma separated list of up to 10 container IDs" — Meta's content-publishing reference. */
export const INSTAGRAM_CAROUSEL_MAX = 10;

/** Narrowest accepted feed image: 4:5 portrait. */
export const INSTAGRAM_MIN_ASPECT = 4 / 5;

/** Widest accepted feed image: 1.91:1 landscape. */
export const INSTAGRAM_MAX_ASPECT = 1.91;

/**
 * Instagram's own ceiling for a feed image.
 *
 * Worth stating that this rule will essentially never fire here: the marketing
 * library refuses an upload over 4 MB (`lib/marketing/media.ts`), because a
 * Vercel function rejects a larger request body before our code runs. It is
 * kept anyway because it is Instagram's rule rather than ours, and a bucket
 * whose contents arrived some other way would otherwise fail at publish time
 * with Meta's wording instead of here with ours.
 */
export const INSTAGRAM_MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * The entry kinds this plugin publishes.
 *
 * Only `post`. Compose offers `reel`, `story` and `boost` as well, and each
 * gets its own refusal below rather than a shared shrug, because the reasons
 * are genuinely different: a reel is waiting on video support the whole app
 * lacks, a story is a different endpoint nobody has asked for, and a boost is
 * ad spend this module was explicitly told not to touch.
 */
export const INSTAGRAM_KINDS = ["post"] as const;

/** JPEG only. "Extended JPEG formats such as MPO and JPS are not supported" either. */
const JPEG_EXTENSIONS = new Set(["jpg", "jpeg"]);

/**
 * The file extension of a media URL, lower-cased, or null.
 *
 * The extension is all there is to go on: `marketing_media` records a type
 * (`image` / `video`) and a URL but no mime, and the upload path names every
 * object `{uuid}.{ext}` from the mime it accepted. So the extension is not a
 * guess about the bytes — it is what the uploader decided they were.
 */
function extensionOf(url: string): string | null {
  const withoutQuery = url.split(/[?#]/)[0];
  const name = withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot < 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/** The last path segment of a media URL, for naming the offending image in a sentence. */
function fileNameOf(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0];
  return withoutQuery.slice(withoutQuery.lastIndexOf("/") + 1) || url;
}

/** A letter, a number or an underscore, in any script. */
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Hashtags in a caption, counted the way Instagram links them.
 *
 * Unicode letters and numbers, because a hashtag is not ASCII-only, and two
 * rules about what precedes the `#` that between them cover the cases people
 * actually write:
 *
 *   * `no#5` is not a hashtag — a `#` in the middle of a word is punctuation.
 *   * `#one#two` is two — a hashtag butted straight onto the previous one is
 *     how a caption full of tags is usually typed.
 *
 * A regex lookbehind can express the first rule or the second but not both,
 * which is why this is a loop.
 */
export function countHashtags(caption: string): number {
  let count = 0;
  let previousEnd = -1;

  for (const match of caption.matchAll(/#[\p{L}\p{N}_]+/gu)) {
    const start = match.index;
    const chained = start === previousEnd;
    if (start === 0 || chained || !WORD_CHARACTER.test(caption[start - 1])) count += 1;
    previousEnd = start + match[0].length;
  }

  return count;
}

/** `1080 × 1350` as `0.80`, for a sentence. Two decimals is enough to see what is wrong. */
function ratio(width: number, height: number): string {
  return (width / height).toFixed(2);
}

/** Bytes as a person reads them. */
function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Whether Instagram will take this entry as it stands.
 *
 * Every failing rule is reported, not just the first: a person fixing a caption
 * only to be told the image is the wrong shape is a person making two trips.
 */
export function validateInstagram(entry: Entry, media: Media[]): ValidationResult {
  const reasons: string[] = [];
  const caption = entry.caption ?? "";

  // ── The kind ───────────────────────────────────────────────────────────────
  if (entry.kind === "reel") {
    reasons.push("A reel is a video, and this app cannot publish video yet. Post it as an image or a carousel instead.");
  } else if (entry.kind === "story") {
    reasons.push("Instagram stories are not published from here yet — only feed posts and carousels are.");
  } else if (entry.kind === "boost") {
    reasons.push("Boosting is ad spend, and nothing in marketing spends money. Post it unboosted and boost it in Meta if you need to.");
  } else if (!(INSTAGRAM_KINDS as readonly string[]).includes(entry.kind)) {
    reasons.push(`Instagram publishes posts and carousels. It has nothing to do with an entry of kind "${entry.kind}".`);
  }

  // ── How many pieces of media ──────────────────────────────────────────────
  // There is no "at least two" rule, and its absence is deliberate. Instagram's
  // carousel minimum is two, but one image is not an undersized carousel — it is
  // a post, and `publish` sends it down the single-image path. So the count rule
  // is one to ten, and nobody is told to add an image they did not want.
  if (media.length === 0) {
    reasons.push("An Instagram post needs at least one image. A caption on its own cannot be posted.");
  } else if (media.length > INSTAGRAM_CAROUSEL_MAX) {
    reasons.push(
      `A carousel holds at most ${INSTAGRAM_CAROUSEL_MAX} images and this entry has ${media.length}. Remove ${media.length - INSTAGRAM_CAROUSEL_MAX}.`,
    );
  }

  // ── Each piece of media ───────────────────────────────────────────────────
  media.forEach((item, index) => {
    const name = fileNameOf(item.url);
    const position = media.length > 1 ? `Image ${index + 1} (${name})` : name;

    if (item.type !== "image") {
      reasons.push(`${position} is a video, and this app cannot publish video to Instagram yet.`);
      return; // The rest of the rules are about images. Saying them too is noise.
    }

    const ext = extensionOf(item.url);
    if (ext === null) {
      reasons.push(`${position} has no file extension, so there is no way to tell whether Instagram will accept it. Re-upload it as a JPEG.`);
    } else if (!JPEG_EXTENSIONS.has(ext)) {
      reasons.push(`${position} is a .${ext} file. Instagram only accepts JPEG images — re-export it as a .jpg.`);
    }

    if (item.bytes !== null && item.bytes > INSTAGRAM_MAX_IMAGE_BYTES) {
      reasons.push(
        `${position} is ${megabytes(item.bytes)}. Instagram's limit for a feed image is ${megabytes(INSTAGRAM_MAX_IMAGE_BYTES)}.`,
      );
    }

    // Dimensions are nullable because they are whatever the upload could be
    // measured for. An unmeasured image is not a refusable one.
    if (item.width !== null && item.height !== null && item.width > 0 && item.height > 0) {
      const aspect = item.width / item.height;
      if (aspect < INSTAGRAM_MIN_ASPECT || aspect > INSTAGRAM_MAX_ASPECT) {
        reasons.push(
          `${position} is ${item.width}×${item.height}, a ratio of ${ratio(item.width, item.height)}:1. ` +
            `Instagram accepts between 4:5 (0.80) and 1.91:1 — crop it before posting.`,
        );
      }
    }
  });

  // ── The caption ───────────────────────────────────────────────────────────
  if (caption.length > INSTAGRAM_CAPTION_LIMIT) {
    reasons.push(
      `This caption is ${caption.length.toLocaleString("en-US")} characters. Instagram's limit is ${INSTAGRAM_CAPTION_LIMIT.toLocaleString("en-US")}.`,
    );
  }

  const hashtags = countHashtags(caption);
  if (hashtags > INSTAGRAM_HASHTAG_LIMIT) {
    reasons.push(`This caption has ${hashtags} hashtags. Instagram allows ${INSTAGRAM_HASHTAG_LIMIT} on a post.`);
  }

  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
