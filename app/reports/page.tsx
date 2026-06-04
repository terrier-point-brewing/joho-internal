"use client";

import { redirect } from "next/navigation";

export default function ReportsRedirect() {
  redirect("/taproom?tab=reports");
}
