import { redirect } from "next/navigation";

// The canon editor moved into the Brand Guide's in-page tabs
// (Palette/Theme/Type/Content) — keep old bookmarks working.
export default function CanonRedirect() {
  redirect("/brand/guide");
}
