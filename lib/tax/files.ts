/**
 * Confirmation-file upload/download for `tax_tasks` — first use of Supabase
 * Storage in this app. Bucket `tax-confirmations` is PRIVATE (public=false)
 * with no object-level RLS policies, so every call here must be made with
 * the service-role admin client (`createSupabaseAdminClient()`); the
 * anon/browser client cannot read or write this bucket at all.
 *
 * Storage object path: `${taskId}/${crypto.randomUUID()}-${safeName}` — the
 * random segment avoids collisions when the same file name is uploaded
 * twice for one task, while keeping objects grouped by task for cleanup.
 * `safeName` strips any path separators from the user-supplied file name so
 * it can't escape the `${taskId}/` grouping (see uploadTaskFile).
 *
 * DB wrappers take an injected `SupabaseClient` as the first arg, same
 * convention as lib/tax/tasks.ts, so they're testable with a stub (no real
 * DB, no real Storage).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxTaskFile } from "./types";

const BUCKET = "tax-confirmations";
const SIGNED_URL_EXPIRY_SECONDS = 60;

export interface UploadTaskFileInput {
  file: File | Blob | Buffer;
  fileName: string;
  label: string | null;
  userId: string | null;
}

/**
 * Uploads `file` to the tax-confirmations bucket, then inserts a
 * `tax_task_files` row pointing at it. If the storage upload fails, the row
 * is never inserted — the DB should never reference an object that doesn't
 * exist in Storage.
 */
export async function uploadTaskFile(
  sb: SupabaseClient,
  taskId: string,
  input: UploadTaskFileInput,
): Promise<TaxTaskFile> {
  // input.fileName is user-supplied (from File.name) — take only the last
  // path segment and strip any separators so it can't escape the
  // `${taskId}/` key grouping (or traverse on a local-filesystem Storage
  // backend). The original name is still stored in the `file_name` column
  // for display.
  const safeName = input.fileName.split(/[\\/]/).pop()!.replace(/[\\/]/g, "_") || "file";
  const storagePath = `${taskId}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, input.file);
  if (uploadError) throw new Error(uploadError.message);

  const { data, error } = await sb
    .from("tax_task_files")
    .insert({
      task_id: taskId,
      storage_path: storagePath,
      file_name: input.fileName,
      label: input.label,
      uploaded_by: input.userId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  return data as TaxTaskFile;
}

export async function listTaskFiles(sb: SupabaseClient, taskId: string): Promise<TaxTaskFile[]> {
  const { data, error } = await sb
    .from("tax_task_files")
    .select("*")
    .eq("task_id", taskId)
    .order("uploaded_at", { ascending: true });
  if (error) throw new Error(error.message);
  return (data ?? []) as TaxTaskFile[];
}

/** Looks up a file row scoped to its parent task — a fileId that belongs to
 * a different task is treated as not found, so callers can't read/delete
 * another task's file by guessing/reusing an id. */
async function getFileRow(sb: SupabaseClient, taskId: string, fileId: string): Promise<TaxTaskFile> {
  const { data, error } = await sb
    .from("tax_task_files")
    .select("*")
    .eq("id", fileId)
    .eq("task_id", taskId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("File not found");
  return data as TaxTaskFile;
}

/** Short-lived signed URL (60s) for the file's storage object — the only
 * way to read it back, since the bucket is private. */
export async function signedUrlForFile(sb: SupabaseClient, taskId: string, fileId: string): Promise<string> {
  const row = await getFileRow(sb, taskId, fileId);

  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_EXPIRY_SECONDS);
  if (error) throw new Error(error.message);

  return (data as { signedUrl: string }).signedUrl;
}

/**
 * Removes the storage object THEN deletes the row — order matters: if the
 * row were deleted first and the storage remove then failed, the object's
 * path would be lost with no way to clean it up later.
 */
export async function deleteTaskFile(sb: SupabaseClient, taskId: string, fileId: string): Promise<void> {
  const row = await getFileRow(sb, taskId, fileId);

  const { error: removeError } = await sb.storage.from(BUCKET).remove([row.storage_path]);
  if (removeError) throw new Error(removeError.message);

  const { error } = await sb.from("tax_task_files").delete().eq("id", fileId);
  if (error) throw new Error(error.message);
}
