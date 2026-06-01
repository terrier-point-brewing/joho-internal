import { squareGet } from "./client";

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
}

// Fetch multiple customers in parallel, deduplicated by ID.
export async function fetchCustomers(
  customerIds: string[]
): Promise<Map<string, SquareCustomer>> {
  const unique = [...new Set(customerIds.filter(Boolean))];
  const results = await Promise.all(
    unique.map(async (id) => {
      const data = await squareGet<{ customer?: SquareCustomer }>(`/customers/${id}`);
      return data.customer ?? ({ id } as SquareCustomer);
    })
  );
  return new Map(results.map((c) => [c.id, c]));
}

export function customerDisplayName(c: SquareCustomer | undefined): string {
  if (!c) return "Unknown";
  if (c.company_name) return c.company_name;
  return [c.given_name, c.family_name].filter(Boolean).join(" ") || c.id;
}
