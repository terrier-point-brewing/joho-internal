import { redirect } from "next/navigation";

// Settings consolidated into the /settings hub. Points at the hub root
// rather than a specific group, which the caller may not be able to open.
export default function LegacySettingsRedirect() {
  redirect("/settings");
}
