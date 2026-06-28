import { redirect } from "next/navigation";

export default function SettingsPage() {
  redirect("/production/settings/deposits");
}
