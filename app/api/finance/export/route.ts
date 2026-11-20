// GET /api/finance/export?year=YYYY
//
// The bookkeeper export: one .xlsx with the three statements, an account
// summary, the transaction detail behind the P&L, the chart of accounts, open
// receivables and payables, and manual entries -- for the same months the
// Financials screen shows for that year.
//
// Thin adapter: auth, param parsing, and the response headers. Everything else
// is lib/finance/export.
import { NextRequest, NextResponse } from "next/server";
import { requirePermission, CAP } from "@/lib/auth";
import { apiError } from "@/lib/utils/api";
import { fetchExportData } from "@/lib/finance/export/fetchExportData";
import { buildExportSheets } from "@/lib/finance/export/workbook";
import { buildXlsx } from "@/lib/finance/export/xlsx";
import { parseExportYear } from "@/lib/finance/export/parseParams";

export const dynamic = "force-dynamic";
// Three statements plus a year of transaction detail is several seconds of
// paged reads; the default budget is too tight on a cold start.
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  // The workbook contains transaction-level detail as well as the statements,
  // so it asks for both capabilities rather than the weaker one.
  try {
    await requirePermission(CAP.financeStatementsRead);
    await requirePermission(CAP.financeTransactionsRead);
  } catch (res) {
    return res as Response;
  }

  const parsed = parseExportYear(req.nextUrl.searchParams);
  if (!parsed.ok) return apiError(parsed.error, 400);

  try {
    const data = await fetchExportData(parsed.year);
    const bytes = buildXlsx(buildExportSheets(data));
    const { months } = data.pl;
    const filename = `bookkeeper-export-${months[0]}-to-${months[months.length - 1]}.xlsx`;
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(bytes.length),
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    console.error("[finance/export] failed", err);
    return apiError(err);
  }
}
