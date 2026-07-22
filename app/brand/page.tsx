import { redirect } from "next/navigation";

// Bare /brand lands on the guide (the one brand surface open to every
// authenticated user; editor tabs are admin-gated within the area).
export default function BrandIndexPage() {
  redirect("/brand/guide");
}
