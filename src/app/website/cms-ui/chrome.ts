import "server-only";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { canEditAny, isDirectEditor } from "@/lib/website-cms/access";
import { PUBLISH_MODULE_KEY } from "@/lib/website-cms/kinds";
import { websitePublicUrl } from "@/lib/website-cms/live-site";
import { listMedia, type MediaView } from "@/lib/website-cms/media-service";
import { scopeFor } from "@/lib/website-cms/review-queries";
import { listItems } from "@/lib/website-cms/service";
import type { ProductOption } from "./cms-env";

/**
 * What every Website screen needs besides its own content: whether this person
 * may publish (so the buttons that would be refused are not drawn), whether they
 * hand their work in for review instead, the image library, the public site's
 * address, and the catalogue.
 *
 * The buttons are a courtesy. Every action is checked again on the server.
 *
 * WHERE ASSIGNMENTS ARE ENFORCED the lists below are narrowed to what the person
 * may see, because they are drawn into every editor on every screen:
 *   - the image library is theirs to pick from, but "used by" would name content
 *     that belongs to somebody else, so it says only that something uses it;
 *   - the catalogue offered to an industry is the live products plus the ones
 *     they were assigned — never somebody else's unpublished draft.
 */
export async function loadChrome(): Promise<{
  canPublish: boolean;
  /** Hands work in for review: edits, holds no direct-edit right. */
  canSubmit: boolean;
  media: MediaView[];
  siteUrl: string;
  products: ProductOption[];
}> {
  const user = await requireUser();
  const [canPublish, media, products, scope, direct, editor] = await Promise.all([
    canOpenModule(user.id, PUBLISH_MODULE_KEY),
    listMedia(),
    listItems("product"),
    scopeFor(user.id),
    isDirectEditor(user.id),
    canEditAny(user.id),
  ]);
  return {
    canPublish,
    canSubmit: editor && !direct,
    media: scope.everything ? media : media.map((m) => ({ ...m, usedBy: m.usedBy.map(() => "other content") })),
    siteUrl: websitePublicUrl(),
    products: products
      .filter((p) => p.state !== "archived")
      .filter((p) => scope.everything || p.state === "published" || scope.covers("product", p.id))
      .map((p) => ({ slug: String(p.data.slug ?? p.slug), name: String(p.data.name ?? p.slug) })),
  };
}
