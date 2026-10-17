import "server-only";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import type { User } from "@/db/schema";
import { err, type Err } from "@/lib/result";
import { KINDS, MODULE_SLUGS, PUBLISH_MODULE_KEY, moduleKeyFor, type KindKey } from "./kinds";

/* ---------------------------------------------------------------------------
 * WHO MAY DO WHAT TO THE WEBSITE'S CONTENT — checked on the SERVER, by every
 * action and route, from the same module grant the sidebar is drawn from.
 *
 *   editing a kind     → the Website module that owns it (`website.products`…)
 *   uploading images   → any Website module that edits content
 *   publishing / live  → `website.publish`, which is explicit-only: never implied
 *
 * A hidden button is a courtesy. These are the checks. They return the shared
 * error shape rather than redirecting, because a server action has no page to
 * redirect from and a refusal must reach the screen as a message.
 * ------------------------------------------------------------------------- */

export type Gate = { user: User; error: null } | { user: null; error: Err };

const refuse = (what: string): Gate => ({
  user: null,
  error: err(`You do not have access to ${what}.`, "not_permitted"),
});

export async function gateEdit(kind: KindKey): Promise<Gate> {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, moduleKeyFor(kind)))) {
    return refuse(`edit ${KINDS[kind].plural} on the website`);
  }
  return { user, error: null };
}

/** Somebody who holds at least one Website content module — enough to add an image. */
export async function gateAnyEdit(): Promise<Gate> {
  const user = await requireUser();
  if (await canEditAny(user.id)) return { user, error: null };
  return refuse("the website's images");
}

export async function gatePublish(): Promise<Gate> {
  const user = await requireUser();
  if (!(await canOpenModule(user.id, PUBLISH_MODULE_KEY))) {
    return refuse("publish to the live website");
  }
  return { user, error: null };
}

/** Whether a person holds at least one Website content module. */
export async function canEditAny(userId: string): Promise<boolean> {
  for (const slug of MODULE_SLUGS) {
    if (await canOpenModule(userId, `website.${slug}`)) return true;
  }
  return false;
}
