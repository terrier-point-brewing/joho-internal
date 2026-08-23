import { requirePage } from "@/lib/auth";
import { CAP } from "@/lib/auth/capabilities";

/**
 * Marketing admission, and nothing else.
 *
 * `marketing.access` is an admission leaf: read-gated here and used nowhere
 * else in the app. Authority over what marketing DOES lives on the content
 * leaves (`marketing.accounts` today; calendar and publish arrive with later
 * chips), so no content scope ever has to moonlight as a door.
 *
 * Deny goes to requirePage's default terminal (/settings/user/account) rather
 * than "/", which forwards to /taproom/performance and would loop for anyone
 * carrying `taproom.access: none`.
 *
 * Section nav lives in the app sidebar, so this layout is only the gate plus a
 * full-height shell. Each page owns its own padding and scroll structure.
 */
export default async function MarketingLayout({ children }: { children: React.ReactNode }) {
  await requirePage(CAP.marketingAccess);
  return <div className="flex flex-col h-full bg-canvas text-primary">{children}</div>;
}
