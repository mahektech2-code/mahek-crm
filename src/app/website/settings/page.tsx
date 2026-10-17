import { requireUser } from "@/lib/auth";
import { reviewByItem, scopeFor, visibleItems } from "@/lib/website-cms/review-queries";
import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { SettingsScreen } from "../cms-ui/doc-screens";

export default async function WebsiteSettingsPage() {
  const user = await requireUser();
  const scope = await scopeFor(user.id);
  const [items, chrome] = await Promise.all([visibleItems("settings", scope), chromeFor()]);
  const review = await reviewByItem(user.id, items.map((i) => i.id));
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <SettingsScreen item={items[0] ?? null} canPublish={chrome.canPublish} canSubmit={chrome.canSubmit} review={items[0] ? review[items[0].id] : undefined} />
    </CmsEnvProvider>
  );
}
