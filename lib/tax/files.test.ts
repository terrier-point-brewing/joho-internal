import { describe, it, expect, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { TaxTaskFile } from "./types";
import { uploadTaskFile, listTaskFiles, signedUrlForFile, deleteTaskFile } from "./files";

// Stubbed sb whose `.storage.from(bucket)` returns upload/createSignedUrl/remove
// mocks and whose `.from('tax_task_files')` returns insert/select/delete mocks —
// same convention as lib/tax/tasks.test.ts (no real DB, no real Storage).

const sampleFile: TaxTaskFile = {
  id: "F1",
  task_id: "T1",
  storage_path: "T1/abc-uuid-confirmation.pdf",
  file_name: "confirmation.pdf",
  label: "Confirmation receipt",
  uploaded_at: "2026-07-12T00:00:00Z",
  uploaded_by: "USER_1",
};

function makeSb(opts: {
  uploadError?: { message: string } | null;
  insertResult?: { data: unknown; error: unknown };
  storageRemove?: (paths: string[]) => Promise<{ data: unknown; error: unknown }>;
  signedUrlResult?: { data: unknown; error: unknown };
  rowLookupResult?: { data: unknown; error: unknown };
  deleteResult?: { data: unknown; error: unknown };
} = {}) {
  const calls: { kind: string; args: unknown[] }[] = [];

  const storageFrom = vi.fn((bucket: string) => {
    calls.push({ kind: "storage.from", args: [bucket] });
    return {
      upload: vi.fn(async (path: string, file: unknown) => {
        calls.push({ kind: "storage.upload", args: [path, file] });
        if (opts.uploadError) return { data: null, error: opts.uploadError };
        return { data: { path }, error: null };
      }),
      createSignedUrl: vi.fn(async (path: string, expiresIn: number) => {
        calls.push({ kind: "storage.createSignedUrl", args: [path, expiresIn] });
        return opts.signedUrlResult ?? { data: { signedUrl: "https://signed.example/" + path }, error: null };
      }),
      remove: vi.fn(async (paths: string[]) => {
        calls.push({ kind: "storage.remove", args: [paths] });
        if (opts.storageRemove) return opts.storageRemove(paths);
        return { data: null, error: null };
      }),
    };
  });

  const tableFrom = vi.fn((table: string) => {
    calls.push({ kind: "from", args: [table] });
    return {
      insert: (payload: unknown) => {
        calls.push({ kind: "insert", args: [payload] });
        return {
          select: () => ({
            single: async () =>
              opts.insertResult ?? { data: sampleFile, error: null },
          }),
        };
      },
      select: () => ({
        eq: (col: string, val: unknown) => {
          calls.push({ kind: "eq", args: [col, val] });
          return {
            maybeSingle: async () => opts.rowLookupResult ?? { data: sampleFile, error: null },
            order: () => Promise.resolve({ data: [sampleFile], error: null }),
          };
        },
        order: () => Promise.resolve({ data: [sampleFile], error: null }),
      }),
      delete: () => {
        calls.push({ kind: "delete", args: [] });
        return {
          eq: async (_col: string, _val: unknown) => opts.deleteResult ?? { data: null, error: null },
        };
      },
    };
  });

  const sb = {
    storage: { from: storageFrom },
    from: tableFrom,
  } as unknown as SupabaseClient;

  return { sb, calls };
}

describe("uploadTaskFile", () => {
  it("builds the storage path as ${taskId}/${uuid}-${fileName}, uploads, then inserts a row, and returns it", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue("11111111-1111-1111-1111-111111111111");
    const { sb, calls } = makeSb();

    const result = await uploadTaskFile(sb, "T1", {
      file: new Blob(["hello"]),
      fileName: "confirmation.pdf",
      label: "Confirmation receipt",
      userId: "USER_1",
    });

    expect(result).toEqual(sampleFile);

    const uploadCall = calls.find((c) => c.kind === "storage.upload");
    expect(uploadCall?.args[0]).toBe("T1/11111111-1111-1111-1111-111111111111-confirmation.pdf");

    const bucketCall = calls.find((c) => c.kind === "storage.from");
    expect(bucketCall?.args[0]).toBe("tax-confirmations");

    const insertCall = calls.find((c) => c.kind === "insert");
    expect(insertCall?.args[0]).toMatchObject({
      task_id: "T1",
      storage_path: "T1/11111111-1111-1111-1111-111111111111-confirmation.pdf",
      file_name: "confirmation.pdf",
      label: "Confirmation receipt",
      uploaded_by: "USER_1",
    });

    // upload must happen before the row insert
    const uploadIdx = calls.findIndex((c) => c.kind === "storage.upload");
    const insertIdx = calls.findIndex((c) => c.kind === "insert");
    expect(uploadIdx).toBeLessThan(insertIdx);

    vi.restoreAllMocks();
  });

  it("does NOT insert a row when the storage upload fails", async () => {
    const { sb, calls } = makeSb({ uploadError: { message: "storage boom" } });

    await expect(
      uploadTaskFile(sb, "T1", {
        file: new Blob(["hello"]),
        fileName: "confirmation.pdf",
        label: null,
        userId: null,
      })
    ).rejects.toThrow(/storage boom/);

    expect(calls.some((c) => c.kind === "insert")).toBe(false);
  });

  it("throws with the Supabase error message when the row insert fails", async () => {
    const { sb } = makeSb({ insertResult: { data: null, error: { message: "insert boom" } } });

    await expect(
      uploadTaskFile(sb, "T1", {
        file: new Blob(["hello"]),
        fileName: "confirmation.pdf",
        label: null,
        userId: null,
      })
    ).rejects.toThrow(/insert boom/);
  });
});

describe("listTaskFiles", () => {
  it("returns the rows for the given task", async () => {
    const { sb } = makeSb();
    const result = await listTaskFiles(sb, "T1");
    expect(result).toEqual([sampleFile]);
  });
});

describe("signedUrlForFile", () => {
  it("looks up the row then returns a signed URL for its storage_path", async () => {
    const { sb, calls } = makeSb();

    const url = await signedUrlForFile(sb, "F1");

    expect(url).toBe("https://signed.example/T1/abc-uuid-confirmation.pdf");
    const signedCall = calls.find((c) => c.kind === "storage.createSignedUrl");
    expect(signedCall?.args[0]).toBe(sampleFile.storage_path);
    expect(signedCall?.args[1]).toBe(60);
  });

  it("throws when the file row does not exist", async () => {
    const { sb } = makeSb({ rowLookupResult: { data: null, error: null } });
    await expect(signedUrlForFile(sb, "missing")).rejects.toThrow(/not found/i);
  });
});

describe("deleteTaskFile", () => {
  it("removes the storage object THEN deletes the row", async () => {
    const { sb, calls } = makeSb();

    await deleteTaskFile(sb, "F1");

    const removeIdx = calls.findIndex((c) => c.kind === "storage.remove");
    const fromCalls = calls.filter((c) => c.kind === "from" && c.args[0] === "tax_task_files");
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(calls[removeIdx].args[0]).toEqual([sampleFile.storage_path]);
    // second `from('tax_task_files')` call (for delete) must occur after remove
    expect(fromCalls.length).toBeGreaterThanOrEqual(2);
    const secondFromIdx = calls.indexOf(fromCalls[1]);
    expect(secondFromIdx).toBeGreaterThan(removeIdx);
  });

  it("throws when the file row does not exist", async () => {
    const { sb } = makeSb({ rowLookupResult: { data: null, error: null } });
    await expect(deleteTaskFile(sb, "missing")).rejects.toThrow(/not found/i);
  });

  it("throws with the storage error message and does not delete the row if remove fails", async () => {
    const { sb, calls } = makeSb({ storageRemove: async () => ({ data: null, error: { message: "remove boom" } }) });

    await expect(deleteTaskFile(sb, "F1")).rejects.toThrow(/remove boom/);
    expect(calls.some((c) => c.kind === "delete")).toBe(false);
  });
});
