import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for one Website module — the same shape the Website
 * Enquiries worklist uses (`app/enquiries/list/layout.tsx`).
 *
 * The app's layout only proves the person holds the Website app and at least
 * one of its modules. It cannot know which screen is being asked for, so each
 * module's folder carries a layout that calls this with its own slug. A person
 * without that module is sent where `requireModule` sends everybody — to the
 * first screen they do hold, or the launcher if there is none. Hiding a link
 * is a courtesy; this is the check.
 *
 * `slug` is the module key's tail: `website.products` is `"products"`, and the
 * dashboard (`website.dashboard`, the app root) is `"dashboard"`.
 */
export async function requireWebsiteModule(slug: string): Promise<void> {
  const user = await requireUser();
  await requireModule(user.id, `website.${slug}`);
}
