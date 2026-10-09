import { listItems } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { NavigationScreen } from "../cms-ui/doc-screens";

export default async function WebsiteNavigationPage() {
  const [items, chrome] = await Promise.all([listItems("navigation"), chromeFor()]);
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <NavigationScreen item={items[0] ?? null} canPublish={chrome.canPublish} />
    </CmsEnvProvider>
  );
}
