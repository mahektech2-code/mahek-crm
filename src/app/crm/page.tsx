import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserModules } from "@/lib/access";

/**
 * `/crm` ITSELF, which answered 404.
 *
 * Every other app in MahekOne has a root screen — `/accounts` is Today,
 * `/sales` is Today — and the CRM's root was the one address with nothing
 * behind it: sign-in redirects straight to `/crm/dashboard`, every sidebar
 * link names a child route, and so the bare app address was never once linked
 * from inside the product. It is what somebody types, what a colleague pastes,
 * and what is left when a URL gets trimmed — and the answer was Next's own
 * 404, which reads as the whole CRM being gone rather than as one address
 * having no page.
 *
 * It is a REDIRECT and not a screen. A second home page would be a second
 * place for "what is waiting for me" to be answered, and the CRM already has
 * one; two would drift.
 *
 * Where it redirects TO is the first module this person actually holds, which
 * is the rule `requireModule` already follows for a withheld route — Dashboard
 * for nearly everybody, and for somebody narrowed to Collections the screen
 * they were given rather than one they would be bounced off. Holding nothing
 * lands on the launcher, which says so plainly.
 */
export default async function Page() {
  const user = await requireUser();
  const allowed = await listUserModules(user.id, "crm");
  redirect(allowed[0]?.href ?? "/apps");
}
