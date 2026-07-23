import { redirect } from "next/navigation";

// Canon version history moved into the Brand Guide's in-page History tab —
// keep old bookmarks working.
export default function CanonHistoryRedirect() {
  redirect("/brand/guide");
}
