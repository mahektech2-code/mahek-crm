import "server-only";
import { canOpenModule } from "@/lib/access";
import { requireUser } from "@/lib/auth";
import { PUBLISH_MODULE_KEY } from "@/lib/website-cms/kinds";
import { websitePublicUrl } from "@/lib/website-cms/live-site";
import { listMedia, type MediaView } from "@/lib/website-cms/media-service";
import { listItems } from "@/lib/website-cms/service";
import type { ProductOption } from "./cms-env";

/**
 * What every Website screen needs besides its own content: whether this person
 * may publish (so the buttons that would be refused are not drawn), the image
 * library, the public site's address, and the catalogue.
 *
 * The buttons are a courtesy. Every action is checked again on the server.
 */
export async function loadChrome(): Promise<{
  canPublish: boolean;
  media: MediaView[];
  siteUrl: string;
  products: ProductOption[];
}> {
  const user = await requireUser();
  const [canPublish, media, products] = await Promise.all([
    canOpenModule(user.id, PUBLISH_MODULE_KEY),
    listMedia(),
    listItems("product"),
  ]);
  return {
    canPublish,
    media,
    siteUrl: websitePublicUrl(),
    products: products
      .filter((p) => p.state !== "archived")
      .map((p) => ({ slug: String(p.data.slug ?? p.slug), name: String(p.data.name ?? p.slug) })),
  };
}
