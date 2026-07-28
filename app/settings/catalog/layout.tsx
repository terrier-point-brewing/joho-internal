import { requirePage, CAP } from "@/lib/auth";

/**
 * Square Item Mappings is `catalog`, not `production.settings` — the same
 * component used to answer to two different scopes depending on the route
 * it was mounted at.
 */
export default async function SquareLinksLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.catalogRead);
  return <>{children}</>;
}
