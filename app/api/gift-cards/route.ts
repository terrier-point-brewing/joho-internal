import { NextRequest, NextResponse } from "next/server";
import { fetchCompletedOrders } from "@/lib/square/orders";
import { requireDateRange, apiError } from "@/lib/utils/api";
import { cents } from "@/lib/utils/formatting";
import { mapDiscountsByUid } from "@/lib/utils/orders";

export async function GET(req: NextRequest) {
  const range = requireDateRange(req);
  if (range instanceof NextResponse) return range;
  const { start, end } = range;

  try {
    const orders = await fetchCompletedOrders(start, end);

    const rows: object[] = [];

    for (const order of orders) {
      const discountByUid = mapDiscountsByUid(order);

      for (const line of order.line_items ?? []) {
        if (line.item_type !== "GIFT_CARD") continue;

        const qty       = parseInt(line.quantity ?? "1", 10);
        const gross     = line.gross_sales_money?.amount ?? 0;
        const discounts = line.total_discount_money?.amount ?? 0;
        const tax       = line.total_tax_money?.amount ?? 0;
        const net       = gross - discounts;

        const discountNames = (line.applied_discounts ?? [])
          .map((ad) => discountByUid.get(ad.discount_uid) ?? "Discount")
          .filter(Boolean);

        const d = new Date(order.closed_at ?? order.created_at);

        rows.push({
          date:           d.toLocaleDateString("en-US"),
          time:           d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
          name:           line.name,
          qty,
          face_value:     cents(line.base_price_money?.amount ?? 0),
          gross_sales:    cents(gross),
          discounts:      cents(discounts),
          discount_names: discountNames,
          net_sales:      cents(net),
          tax:            cents(tax),
          order_id:       order.id,
        });
      }
    }

    rows.sort((a, b) => {
      const aa = a as { date: string; time: string };
      const bb = b as { date: string; time: string };
      return new Date(`${bb.date} ${bb.time}`).getTime() -
             new Date(`${aa.date} ${aa.time}`).getTime();
    });

    return NextResponse.json({ rows });
  } catch (err) {
    return apiError(err);
  }
}
