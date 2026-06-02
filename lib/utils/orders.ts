import type { Order } from "@/types/square";

export function mapDiscountsByUid(order: Order): Map<string, string> {
  return new Map((order.discounts ?? []).map((d) => [d.uid, d.name]));
}
