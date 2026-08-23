/**
 * Upload one creative into the marketing library.
 *
 * `multipart/form-data`, field `file`, mirroring app/api/brand/assets/route.ts
 * and lib/tax/files.ts: **upload to storage through the admin client first,
 * then insert the row.** A row pointing at bytes that are not there is a
 * defect every reader downstream has to handle forever; an orphaned object is
 * invisible and costs nothing.
 *
 * ── Why there is no `media/complete` ────────────────────────────────────────
 * The spec pairs this route with a second one for a two-step (presigned)
 * upload, and it is not built, because the single step genuinely carries the
 * files this chip accepts:
 *
 *   * A Next.js 16 Route Handler imposes no body-size limit of its own — the
 *     old 4 MB cap was `pages/api`'s `bodyParser`, and App Router handlers read
 *     the request as a stream instead.
 *   * The real ceiling is the platform's: a Vercel function rejects a request
 *     body over 4.5 MB before any of our code runs. lib/marketing/media.ts caps
 *     uploads just under that so the refusal is a sentence rather than an
 *     opaque 413.
 *   * The only creative that routinely exceeds 4.5 MB is video, and video
 *     handling is explicitly out of scope for this chip.
 *
 * So a second route would be a mechanism with nothing to carry. When video
 * lands, it will need a presigned upload and this is where that decision gets
 * revisited — with the transcoding and duration questions it comes with.
 *
 * Optional form fields: `width`, `height`, `duration_s`, `tags` (comma
 * separated). All nullable, none inferred: a plugin that needs a dimension says
 * so in `validate`, in a sentence, rather than assuming one.
 */
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { apiError } from "@/lib/utils/api";
import {
  MEDIA_BUCKET,
  insertMedia,
  mediaStoragePath,
  publicMediaUrl,
  validateMediaUpload,
} from "@/lib/marketing/media";

export const dynamic = "force-dynamic";

/** A positive integer form field, or null when absent or nonsense. */
function intField(form: FormData, field: string): number | null {
  const raw = form.get(field);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function POST(req: NextRequest) {
  let session;
  try {
    session = await requirePermission(CAP.marketingCalendarEdit);
  } catch (res) {
    return res as Response;
  }

  try {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return NextResponse.json({ error: "Expected multipart/form-data." }, { status: 400 });
    }

    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "No file provided." }, { status: 400 });
    }

    // Enforced here rather than by the file picker's `accept`, which a browser
    // is free to ignore.
    const checked = validateMediaUpload(file);
    if ("error" in checked) {
      return NextResponse.json({ error: checked.error }, { status: 400 });
    }

    const admin = createSupabaseAdminClient();
    const storagePath = mediaStoragePath({ filename: file.name, mime: file.type });

    const { error: uploadError } = await admin.storage
      .from(MEDIA_BUCKET)
      .upload(storagePath, file, { contentType: file.type });
    if (uploadError) throw new Error(uploadError.message);

    const tagsRaw = form.get("tags");
    const tags =
      typeof tagsRaw === "string" && tagsRaw.trim()
        ? tagsRaw.split(",").map((t) => t.trim()).filter(Boolean)
        : null;

    const media = await insertMedia(admin, {
      type: checked.type,
      url: publicMediaUrl(admin, storagePath),
      storagePath,
      width: intField(form, "width"),
      height: intField(form, "height"),
      durationS: intField(form, "duration_s"),
      bytes: file.size,
      tags,
      createdBy: session.user.id,
    });

    return NextResponse.json(media, { status: 201 });
  } catch (err) {
    return apiError(err);
  }
}
