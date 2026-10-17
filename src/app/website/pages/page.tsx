import { listItems } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { PagesScreen } from "../cms-ui/doc-screens";

export default async function WebsitePagesPage() {
  const [items, chrome] = await Promise.all([listItems("page"), chromeFor()]);
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <PagesScreen items={items} canPublish={chrome.canPublish} />
    </CmsEnvProvider>
  );
}
