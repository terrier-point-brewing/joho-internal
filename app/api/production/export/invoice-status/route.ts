import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { getExportInvoiceStatus } from "@/lib/square/export-invoices";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try { await requireRole(["viewer", "brewer", "manager"]); } catch (res) { return res as Response; }

  const invoiceId = req.nextUrl.searchParams.get("invoiceId");
  if (!invoiceId) {
    return NextResponse.json({ error: "invoiceId is required" }, { status: 400 });
  }

  try {
    const status = await getExportInvoiceStatus(invoiceId);
    return NextResponse.json(status);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch invoice status";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
