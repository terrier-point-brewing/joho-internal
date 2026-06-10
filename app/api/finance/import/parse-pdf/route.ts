/**
 * POST /api/finance/import/parse-pdf
 *
 * Accepts multipart/form-data with one or more PDF files (field name: "files").
 * Returns an array of parsed invoice previews, one per file.
 * The caller presents these for review, then POSTs the confirmed payloads to
 * /api/finance/ledger/invoices.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { parseQBInvoicePDF } from "@/lib/finance/qb-pdf";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try { await requireRole("admin"); } catch (res) { return res as Response; }

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Expected multipart/form-data" }, { status: 400 });
  }

  const files = formData.getAll("files") as File[];
  if (files.length === 0) {
    return NextResponse.json({ error: "No files provided" }, { status: 400 });
  }

  const results = await Promise.all(
    files.map(async (file) => {
      const buffer   = Buffer.from(await file.arrayBuffer());
      const result   = await parseQBInvoicePDF(buffer, file.name);
      return {
        filename: file.name,
        payload:  result.payload,
        warnings: result.warnings,
      };
    })
  );

  return NextResponse.json({ results });
}
