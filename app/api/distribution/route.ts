import { NextRequest, NextResponse } from "next/server";
import { fetchCatalogItems } from "@/lib/square/catalog";
import { fetchInvoiceOrders } from "@/lib/square/orders";
import { fetchCustomers } from "@/lib/square/customers";
import { buildDistributionReport } from "@/lib/reports/distribution";

function cents(n: number) { return (n / 100).toFixed(2); }

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const start = searchParams.get("start");
  const end   = searchParams.get("end");
  if (!start || !end) return NextResponse.json({ error: "start and end required" }, { status: 400 });

  try {
    const [catalogItems, orders] = await Promise.all([
      fetchCatalogItems(),
      fetchInvoiceOrders(start, end),
    ]);

    const customerIds = [...new Set(orders.map((o) => o.customer_id).filter(Boolean) as string[])];
    const customers   = await fetchCustomers(customerIds);

    const result = buildDistributionReport(orders, catalogItems, customers);

    return NextResponse.json({
      by_size: result.bySize.map((r) => ({
        size:        r.size,
        qty:         r.qty,
        gross_sales: cents(r.grossCents),
        discounts:   cents(r.discountsCents),
        net_sales:   cents(r.netCents),
      })),
      by_customer: result.byCustomer.map((r) => ({
        customer:          r.customerName,
        invoices:          r.invoiceCount,
        total_charged:     cents(r.totalChargedCents),
        total_outstanding: cents(r.totalOutstandingCents),
        half_keg_qty:      r.halfKegQty,
        sixth_keg_qty:     r.sixthKegQty,
        quarter_keg_qty:   r.quarterKegQty,
        cans_qty:          r.cansQty,
      })),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
