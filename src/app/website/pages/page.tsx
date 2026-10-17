import { requireUser } from "@/lib/auth";
import { reviewByItem, scopeFor, visibleItems } from "@/lib/website-cms/review-queries";
import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { PagesScreen } from "../cms-ui/doc-screens";

export default async function WebsitePagesPage() {
  const user = await requireUser();
  const scope = await scopeFor(user.id);
  const [items, chrome] = await Promise.all([visibleItems("page", scope), chromeFor()]);
  const review = await reviewByItem(user.id, items.map((i) => i.id));
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <PagesScreen items={items} canPublish={chrome.canPublish} canSubmit={chrome.canSubmit} review={review} />
    </CmsEnvProvider>
  );
}
