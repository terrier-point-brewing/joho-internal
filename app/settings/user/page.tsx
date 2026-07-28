import { redirect } from "next/navigation";

export default function UserSettingsIndex() {
  redirect("/settings/user/account");
}
