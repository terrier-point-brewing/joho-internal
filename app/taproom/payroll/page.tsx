import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export default async function TaproomPayrollRoot() {
  const supabase = await createSupabaseServerClient();

  // Find the current open period, or most recent period
  const { data } = await supabase
    .from("pay_periods")
    .select("id, status")
    .order("start_date", { ascending: false })
    .limit(5);

  const openPeriod = data?.find((p) => p.status === "open");
  const target = openPeriod ?? data?.[0];

  if (target) redirect(`/taproom/payroll/${target.id}`);

  // No periods yet
  return (
    <main className="px-4 sm:px-6 py-8">
      <p className="text-zinc-500 text-sm">No pay periods found. An admin needs to create the first period.</p>
    </main>
  );
}
