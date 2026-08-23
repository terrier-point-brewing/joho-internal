import { redirect } from "next/navigation";
import { getSessionUser, CAP, can } from "@/lib/auth";
import { getCanon } from "@/lib/brand/getCanon";
import { canonTokenChoices } from "@/lib/brand/seasons";
import TemplatesView from "./TemplatesView";

// Templates — layout authoring and the season rotation. Gated on
// brand.templates:read, matching the nav entry so a visible tab never leads to
// a redirect.
//
// The canon's palette is read here rather than through a route of its own: a
// season's palette roles may only name a colour the canon declares, and this
// page is already a server component with the cached canon a call away. What
// crosses into the client is a plain list of {key, name, hex} — the vocabulary,
// not the document.
export default async function TemplatesPage() {
  const session = await getSessionUser();
  if (!session || !can(session.grants, CAP.brandTemplatesRead.scope, CAP.brandTemplatesRead.level)) {
    redirect("/brand/guide");
  }
  return <TemplatesView tokens={canonTokenChoices(await getCanon())} />;
}
