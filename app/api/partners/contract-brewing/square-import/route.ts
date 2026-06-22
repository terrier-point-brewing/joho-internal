import { NextRequest, NextResponse } from "next/server";
import { requireRole } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { squareGet } from "@/lib/square/client";
import { SquareCustomer, customerAddressString } from "@/lib/square/customers";

export const dynamic = "force-dynamic";

/**
 * POST /api/partners/contract-brewing/square-import
 *
 * Body (one of two modes):
 *   { square_customer_id: string }                          — fresh import, creates new partner
 *   { square_customer_id: string; partner_id: string }      — link Square contact to existing partner
 *
 * In both cases the partner's fields are synced from Square.
 */
export async function POST(req: NextRequest) {
  try { await requireRole([]); } catch (res) { return res as Response; }


  const supabase = await createSupabaseServerClient();

  const body = await req.json();
  const { square_customer_id, partner_id } = body as {
    square_customer_id: string;
    partner_id?: string;
  };

  if (!square_customer_id) {
    return NextResponse.json({ error: "square_customer_id is required" }, { status: 400 });
  }

  // Fetch contact from Square
  let customer: SquareCustomer;
  try {
    const res = await squareGet<{ customer?: SquareCustomer }>(
      `/customers/${square_customer_id}`
    );
    if (!res.customer) {
      return NextResponse.json({ error: "Square contact not found" }, { status: 404 });
    }
    customer = res.customer;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Square API error";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  // Build the fields to sync from Square
  const syncedFields = {
    company_name:
      customer.company_name ||
      [customer.given_name, customer.family_name].filter(Boolean).join(" ") ||
      "Unknown",
    first_name: customer.given_name ?? null,
    last_name: customer.family_name ?? null,
    email: customer.email_address ?? null,
    phone: customer.phone_number ?? null,
    address: customerAddressString(customer) || null,
    square_customer_id,
  };

  if (partner_id) {
    // Link mode — update existing partner
    const { data, error } = await supabase
      .from("contract_brewing_partners")
      .update(syncedFields)
      .eq("id", partner_id)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data);
  } else {
    // Fresh import mode — create new partner
    const { data, error } = await supabase
      .from("contract_brewing_partners")
      .insert(syncedFields)
      .select()
      .single();

    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json(data, { status: 201 });
  }
}
