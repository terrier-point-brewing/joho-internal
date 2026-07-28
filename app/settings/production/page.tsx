import { redirect } from "next/navigation";

export default function ProductionSettingsIndex() {
  redirect("/settings/production/deposits");
}
