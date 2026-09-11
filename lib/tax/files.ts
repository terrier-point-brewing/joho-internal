/**
 * File upload/download for the tax module — first use of Supabase Storage
 * in this app. Two kinds of files share the private `tax-confirmations`
 * bucket (public=false, no object-level RLS policies, so every call here
 * must be made with the service-role admin client
 * (`createSupabaseAdminClient()`); the anon/browser client cannot read or
 * write this bucket at all):
 *
 *   - `tax_task_files` — confirmation/support files attached to ONE task
 *     (scoped by `task_id`), uploaded when completing a filing.
 *   - `tax_form_files` — filing-form templates (e.g. a partially prefilled
 *     B-C-710 PDF) attached to a party MODULE (scoped by `party_key`),
 *     managed in Settings → Tax Filing and reused by every period's task.
 *
 * Storage object path: `${scope}/${crypto.randomUUID()}-${safeName}` where
 * scope is the task id or party key — the random segment avoids collisions
 * when the same file name is uploaded twice for one scope, while keeping
 * objects grouped for cleanup. `safeName` strips any path separators from
 * the user-supplied file name so it can't escape the scope grouping.
 *
 * DB wrappers take an injected `SupabaseClient` as the first arg, same
 * convention as lib/tax/tasks.ts, so they're testable with a stub (no real
 * DB, no real Storage).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxTaskFile, TaxFormFile } from "./types";

const BUCKET = "tax-confirmations";
const SIGNED_URL_EXPIRY_SECONDS = 60;

export interface UploadTaxFileInput {
  file: File | Blob | Buffer;
  fileName: string;
  label: string | null;
  userId: string | null;
}

/** Which table a call operates on, and the column its scope value filters. */
type FileTable = { table: "tax_task_files"; scopeColumn: "task_id" } | { table: "tax_form_files"; scopeColumn: "party_key" };
const TASK_FILES: FileTable = { table: "tax_task_files", scopeColumn: "task_id" };
const FORM_FILES: FileTable = { table: "tax_form_files", scopeColumn: "party_key" };

interface FileRow {
  id: string;
  storage_path: string;
}

/**
 * Uploads `file` to the bucket, then inserts a row pointing at it. If the
 * storage upload fails, the row is never inserted — the DB should never
 * reference an object that doesn't exist in Storage.
 */
async function uploadFile(sb: SupabaseClient, t: FileTable, scope: string, input: UploadTaxFileInput): Promise<unknown> {
  // input.fileName is user-supplied (from File.name) — take only the last
  // path segment and strip any separators so it can't escape the
  // `${scope}/` key grouping (or traverse on a local-filesystem Storage
  // backend). The original name is still stored in the `file_name` column
  // for display.
  const safeName = input.fileName.split(/[\\/]/).pop()!.replace(/[\\/]/g, "_") || "file";
  const storagePath = `${scope}/${crypto.randomUUID()}-${safeName}`;

  const { error: uploadError } = await sb.storage.from(BUCKET).upload(storagePath, input.file);
  if (uploadError) throw new Error(uploadError.message);

  const { data, error } = await sb
    .from(t.table)
    .insert({
      [t.scopeColumn]: scope,
      storage_path: storagePath,
      file_name: input.fileName,
      label: input.label,
      uploaded_by: input.userId,
    })
    .select()
    .single();
  if (error) throw new Error(error.message);

  return data;
}

async function listFiles(sb: SupabaseClient, t: FileTable, scope: string): Promise<unknown[]> {
  const { data, error } = await sb
    .from(t.table)
    .select("*")
    .eq(t.scopeColumn, scope)
    .order("uploaded_at", { ascending: true });
  if (error) throw new Error(error.message);
  return data ?? [];
}

/** Looks up a file row scoped to its parent (task or party) — a fileId that
 * belongs to a different scope is treated as not found, so callers can't
 * read/delete another scope's file by guessing/reusing an id. */
async function getFileRow(sb: SupabaseClient, t: FileTable, scope: string, fileId: string): Promise<FileRow> {
  const { data, error } = await sb
    .from(t.table)
    .select("*")
    .eq("id", fileId)
    .eq(t.scopeColumn, scope)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("File not found");
  return data as FileRow;
}

/** Short-lived signed URL (60s) for the file's storage object — the only
 * way to read it back, since the bucket is private. */
async function signedUrl(sb: SupabaseClient, t: FileTable, scope: string, fileId: string): Promise<string> {
  const row = await getFileRow(sb, t, scope, fileId);

  const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(row.storage_path, SIGNED_URL_EXPIRY_SECONDS);
  if (error) throw new Error(error.message);

  return (data as { signedUrl: string }).signedUrl;
}

/**
 * Removes the storage object THEN deletes the row — order matters: if the
 * row were deleted first and the storage remove then failed, the object's
 * path would be lost with no way to clean it up later.
 */
async function deleteFile(sb: SupabaseClient, t: FileTable, scope: string, fileId: string): Promise<void> {
  const row = await getFileRow(sb, t, scope, fileId);

  const { error: removeError } = await sb.storage.from(BUCKET).remove([row.storage_path]);
  if (removeError) throw new Error(removeError.message);

  const { error } = await sb.from(t.table).delete().eq("id", fileId);
  if (error) throw new Error(error.message);
}

// ── task confirmation files ──────────────────────────────────────────────────

export async function uploadTaskFile(sb: SupabaseClient, taskId: string, input: UploadTaxFileInput): Promise<TaxTaskFile> {
  return (await uploadFile(sb, TASK_FILES, taskId, input)) as TaxTaskFile;
}

export async function listTaskFiles(sb: SupabaseClient, taskId: string): Promise<TaxTaskFile[]> {
  return (await listFiles(sb, TASK_FILES, taskId)) as TaxTaskFile[];
}

export async function signedUrlForFile(sb: SupabaseClient, taskId: string, fileId: string): Promise<string> {
  return signedUrl(sb, TASK_FILES, taskId, fileId);
}

export async function deleteTaskFile(sb: SupabaseClient, taskId: string, fileId: string): Promise<void> {
  return deleteFile(sb, TASK_FILES, taskId, fileId);
}

// ── party form-file templates ────────────────────────────────────────────────

export async function uploadFormFile(sb: SupabaseClient, partyKey: string, input: UploadTaxFileInput): Promise<TaxFormFile> {
  return (await uploadFile(sb, FORM_FILES, partyKey, input)) as TaxFormFile;
}

export async function listFormFiles(sb: SupabaseClient, partyKey: string): Promise<TaxFormFile[]> {
  return (await listFiles(sb, FORM_FILES, partyKey)) as TaxFormFile[];
}

export async function signedUrlForFormFile(sb: SupabaseClient, partyKey: string, fileId: string): Promise<string> {
  return signedUrl(sb, FORM_FILES, partyKey, fileId);
}

export async function deleteFormFile(sb: SupabaseClient, partyKey: string, fileId: string): Promise<void> {
  return deleteFile(sb, FORM_FILES, partyKey, fileId);
}
