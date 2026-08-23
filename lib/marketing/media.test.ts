/**
 * The marketing library's upload rules and its object keys.
 *
 * The path is the interesting part: `{yyyy}/{mm}/{uuid}.{ext}` is a public URL
 * once the object is in a public bucket, so it must never contain a person's
 * filename, and it must never be able to collide with an object already there
 * — an upload that overwrites another entry's creative silently changes a post
 * nobody edited.
 */
import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { MEDIA_MAX_BYTES, insertMedia, mediaExtension, mediaStoragePath, mediaTypeFor, validateMediaUpload } from "./media";
import { createMarketingTestDb } from "./__fixtures__/marketingDb";

const asClient = (db: { client: unknown }) => db.client as unknown as SupabaseClient;

describe("the object key", () => {
  const now = new Date("2026-08-22T15:04:05.000Z");
  const uuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

  it("is {yyyy}/{mm}/{uuid}.{ext}", () => {
    expect(mediaStoragePath({ filename: "IMG_0042.JPG", mime: "image/jpeg", now, uuid })).toBe(
      `2026/08/${uuid}.jpg`,
    );
  });

  it("zero-pads the month, so a listing sorts", () => {
    expect(mediaStoragePath({ filename: "a.png", mime: "image/png", now: new Date("2026-01-05T00:00:00Z"), uuid })).toBe(
      `2026/01/${uuid}.png`,
    );
  });

  it("carries none of the uploader's filename into a public URL", () => {
    const path = mediaStoragePath({ filename: "Q3 launch (final) FINAL v2.png", mime: "image/png", now, uuid });
    expect(path).not.toContain("final");
    expect(path).not.toContain(" ");
  });

  it("is unique per upload, so nothing can overwrite an existing creative", () => {
    const a = mediaStoragePath({ filename: "same.png", mime: "image/png", now });
    const b = mediaStoragePath({ filename: "same.png", mime: "image/png", now });
    expect(a).not.toBe(b);
  });

  it("trusts the mime type over the filename, which is routinely wrong", () => {
    expect(mediaExtension("photo.jpeg", "image/jpeg")).toBe("jpg");
    expect(mediaExtension("no-extension", "image/png")).toBe("png");
    // Nothing known about the type: fall back to a cleaned filename extension.
    expect(mediaExtension("weird.heic", "application/octet-stream")).toBe("heic");
  });
});

describe("what we will store", () => {
  it("takes an image", () => {
    expect(validateMediaUpload({ type: "image/png", size: 1024 })).toEqual({ type: "image" });
  });

  it("stores a video without pretending to handle one", () => {
    // `video` has been valid in the schema since day one. Nothing transcodes,
    // thumbnails or probes it, and `durationS` stays whatever the caller said.
    expect(validateMediaUpload({ type: "video/mp4", size: 1024 })).toEqual({ type: "video" });
    expect(mediaTypeFor("video/quicktime")).toBe("video");
  });

  it("refuses a file that is not a creative", () => {
    expect(validateMediaUpload({ type: "application/pdf", size: 10 })).toEqual({
      error: expect.stringContaining("not something the marketing library stores"),
    });
    expect(validateMediaUpload({ type: "", size: 10 })).toEqual({ error: expect.any(String) });
  });

  it("refuses an empty file and one over the platform's body limit", () => {
    expect(validateMediaUpload({ type: "image/png", size: 0 })).toEqual({ error: "That file is empty." });
    const tooBig = validateMediaUpload({ type: "image/png", size: MEDIA_MAX_BYTES + 1 });
    expect(tooBig).toEqual({ error: expect.stringContaining("The limit is 4 MB") });
  });

  it("caps below Vercel's 4.5 MB request body limit, which is what makes a one-step upload enough", () => {
    expect(MEDIA_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
  });
});

describe("the row", () => {
  it("records the path and the URL, and leaves unmeasured dimensions null", async () => {
    const db = createMarketingTestDb();
    const media = await insertMedia(asClient(db), {
      type: "image",
      url: "https://example.invalid/storage/v1/object/public/marketing-media/2026/08/x.png",
      storagePath: "2026/08/x.png",
      bytes: 4096,
      createdBy: "user-1",
    });

    expect(media.width).toBeNull();
    expect(media.height).toBeNull();
    expect(media.durationS).toBeNull();
    expect(media.bytes).toBe(4096);

    const row = db.tables.marketing_media[0];
    expect(row.storage_path).toBe("2026/08/x.png");
    expect(row.created_by).toBe("user-1");
    // updated_at is the database trigger's; app code never sets it.
    expect(row.updated_at).toBeUndefined();
  });
});
