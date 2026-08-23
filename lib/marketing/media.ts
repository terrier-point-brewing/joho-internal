/**
 * The marketing library: putting a file in the bucket and a row in the table.
 *
 * House order, and it is not arbitrary — **upload to storage first, then insert
 * the row** (`lib/tax/files.ts`, `lib/payroll/gustoUpload.ts`,
 * `app/api/brand/assets/route.ts` all do this). A failed upload after a written
 * row leaves a row pointing at nothing, which every reader downstream has to
 * defend against forever; a failed insert after a written object leaves an
 * orphaned object, which costs pennies and is invisible.
 *
 * There is no shared upload helper in this repo and this is the fourth
 * module-local one. That is house style rather than duplication: each module's
 * rules about what it will accept are the interesting part, and they differ.
 *
 * ── The bucket is public, on purpose ────────────────────────────────────────
 * `marketing-media` is public where `brand-assets` is private, because a
 * channel like Instagram does not accept an upload from us — it accepts a URL
 * and fetches the creative itself. A private bucket cannot publish at all. The
 * migration that created it says the same thing at more length.
 *
 * ── No video handling ───────────────────────────────────────────────────────
 * A video may be STORED — the schema has accepted `video` since day one — and
 * nothing here transcodes, thumbnails or probes one. `durationS` is whatever
 * the caller supplies. A plugin that needs a dimension is expected to say so in
 * `validate`, in a sentence, rather than assume it.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import type { Media, MediaType } from "./plugins/types";

/** Created by the marketing schema migration. Public; see the header. */
export const MEDIA_BUCKET = "marketing-media";

/**
 * The largest file this route accepts.
 *
 * The binding constraint is the platform, not the framework: a Next.js Route
 * Handler has no body-size limit of its own, but a Vercel function rejects a
 * request body over 4.5 MB before our code ever runs — and a rejection there is
 * an opaque 413 a person cannot act on. So the cap is set just under it and
 * enforced here, where the answer can be a sentence.
 *
 * This is also the whole reason there is no two-step `media/complete` route:
 * see the note in app/api/marketing/media/route.ts.
 */
export const MEDIA_MAX_BYTES = 4 * 1024 * 1024;

/** Mime → file extension, for the types we are willing to name. */
const EXTENSION_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
};

/** What a row insert needs, beyond what the upload produced. */
export interface MediaUploadInput {
  type: MediaType;
  url: string;
  storagePath: string;
  width?: number | null;
  height?: number | null;
  durationS?: number | null;
  bytes?: number | null;
  tags?: string[] | null;
  createdBy?: string | null;
}

/** `image` or `video` from a mime type, or null for anything we will not store. */
export function mediaTypeFor(mime: string): MediaType | null {
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  return null;
}

/**
 * The extension for a stored object.
 *
 * The mime type is trusted ahead of the filename because the filename comes
 * from a person's disk and is routinely wrong ("photo" with no extension,
 * ".jpeg" and ".jpg" for the same thing). The filename is the fallback, cleaned
 * hard, because a bucket key is part of a public URL.
 */
export function mediaExtension(filename: string, mime: string): string {
  const known = EXTENSION_BY_MIME[mime];
  if (known) return known;
  const fromName = filename.toLowerCase().match(/\.([a-z0-9]{1,5})$/);
  if (fromName) return fromName[1];
  return mime.startsWith("video/") ? "mp4" : "bin";
}

/**
 * The object key: `{yyyy}/{mm}/{uuid}.{ext}`.
 *
 * Year and month in UTC, and the point of them is purely that a bucket listing
 * stays browsable after a few thousand uploads — nothing reads a date back out
 * of a key. The uuid is what makes the key unique, so two files with the same
 * name never collide and no upload can overwrite another.
 */
export function mediaStoragePath(args: {
  filename: string;
  mime: string;
  now?: Date;
  uuid?: string;
}): string {
  const now = args.now ?? new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const uuid = args.uuid ?? crypto.randomUUID();
  return `${yyyy}/${mm}/${uuid}.${mediaExtension(args.filename, args.mime)}`;
}

/** Whether we will take this file at all. Reasons are sentences; a person reads them. */
export function validateMediaUpload(file: { type: string; size: number }): { type: MediaType } | { error: string } {
  const type = mediaTypeFor(file.type || "");
  if (!type) {
    return { error: `A ${file.type || "file with no type"} is not something the marketing library stores. Upload an image.` };
  }
  if (file.size === 0) return { error: "That file is empty." };
  if (file.size > MEDIA_MAX_BYTES) {
    const mb = (file.size / (1024 * 1024)).toFixed(1);
    return { error: `That file is ${mb} MB. The limit is ${MEDIA_MAX_BYTES / (1024 * 1024)} MB.` };
  }
  return { type };
}

/**
 * The public URL a channel will fetch the creative from.
 *
 * Built from the storage client rather than string-concatenated so it stays
 * correct if the project's storage host ever changes.
 */
export function publicMediaUrl(client: SupabaseClient, storagePath: string): string {
  return client.storage.from(MEDIA_BUCKET).getPublicUrl(storagePath).data.publicUrl;
}

/** Insert the row that points at an object already in the bucket. */
export async function insertMedia(client: SupabaseClient, input: MediaUploadInput): Promise<Media> {
  const { data, error } = await client
    .from("marketing_media")
    .insert({
      type: input.type,
      url: input.url,
      storage_path: input.storagePath,
      width: input.width ?? null,
      height: input.height ?? null,
      duration_s: input.durationS ?? null,
      bytes: input.bytes ?? null,
      tags: input.tags ?? null,
      created_by: input.createdBy ?? null,
      // updated_at belongs to public.update_updated_at(). Never set here.
    })
    .select("id, type, url, width, height, duration_s, bytes");

  if (error) throw new Error(`could not record the upload: ${error.message}`);
  const row = ((data ?? []) as Record<string, unknown>[])[0];
  if (!row) throw new Error("could not record the upload: the insert returned no row");

  return {
    id: String(row.id),
    type: row.type as MediaType,
    url: String(row.url),
    width: (row.width as number | null) ?? null,
    height: (row.height as number | null) ?? null,
    durationS: row.duration_s === null || row.duration_s === undefined ? null : Number(row.duration_s),
    bytes: row.bytes === null || row.bytes === undefined ? null : Number(row.bytes),
  };
}
