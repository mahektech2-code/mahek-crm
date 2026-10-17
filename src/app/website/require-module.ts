import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";
import { canEditAny, holdsReview } from "@/lib/website-cms/access";
import { scopeFor } from "@/lib/website-cms/review-queries";
import { slugVisible } from "@/lib/website-cms/review-scope";

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
 *
 * WHERE ASSIGNMENTS ARE ENFORCED a module is not enough on its own: somebody who
 * holds Products and was assigned nothing in it has no Products screen, because
 * what the screen would list is other people's work. They are sent to My work,
 * which says what they have been given.
 */
export async function requireWebsiteModule(slug: string): Promise<void> {
  const user = await requireUser();
  await requireModule(user.id, `website.${slug}`);
  if (!slugVisible(await scopeFor(user.id), slug)) redirect("/website/my-work");
}

/**
 * My work and a request's own page: for somebody who works on the website or
 * reviews it. What a request page then shows is the command's own rule — the
 * person who submitted it, or a reviewer, and nobody else.
 */
export async function requireWebsiteWorkflow(): Promise<void> {
  const user = await requireUser();
  if (!((await canEditAny(user.id)) || (await holdsReview(user.id)))) redirect("/website");
}

/** The review queue, a request under review, and the assign screen: `website.review`, which nothing implies. */
export async function requireWebsiteReview(): Promise<void> {
  const user = await requireUser();
  if (!(await holdsReview(user.id))) redirect("/website");
}
