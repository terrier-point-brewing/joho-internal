import { squareGet, squarePost, squarePostAll } from "./client";

export interface SquareCustomer {
  id: string;
  given_name?: string;
  family_name?: string;
  company_name?: string;
  email_address?: string;
  phone_number?: string;
  address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;        // city
    administrative_district_level_1?: string; // state
    postal_code?: string;
    country?: string;
  };
}

/** Fetch multiple customers in parallel, deduplicated by ID. */
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

/**
 * Format a Square customer's address into a single string.
 */
export function customerAddressString(c: SquareCustomer): string {
  const a = c.address;
  if (!a) return "";
  return [
    a.address_line_1,
    a.address_line_2,
    a.locality,
    a.administrative_district_level_1,
    a.postal_code,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * Search Square customers by name or email query string.
 * Falls back to listing all customers when query is empty.
 */
export async function searchSquareCustomers(
  query?: string
): Promise<SquareCustomer[]> {
  if (query && query.trim()) {
    const body: Record<string, unknown> = {
      query: {
        filter: {
          email_address: { fuzzy: query },
        },
      },
      limit: 50,
    };

    // Try email fuzzy search first; if that returns nothing, try text search
    const emailResults = await squarePostAll<SquareCustomer>(
      "/customers/search",
      "customers",
      body
    );

    if (emailResults.length > 0) return emailResults;

    // Fall back to searching by given/family name via text filter
    const textResults = await squarePostAll<SquareCustomer>(
      "/customers/search",
      "customers",
      {
        limit: 100,
      }
    );

    const q = query.toLowerCase();
    return textResults.filter((c) => {
      const display = [c.given_name, c.family_name, c.company_name, c.email_address]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return display.includes(q);
    });
  }

  // No query — list first 100 customers
  return squarePostAll<SquareCustomer>("/customers/search", "customers", {
    limit: 100,
  });
}
