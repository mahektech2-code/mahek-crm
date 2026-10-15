import { listItems } from "@/lib/website-cms/service";
import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { SettingsScreen } from "../cms-ui/doc-screens";

export default async function WebsiteSettingsPage() {
  const [items, chrome] = await Promise.all([listItems("settings"), chromeFor()]);
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <SettingsScreen item={items[0] ?? null} canPublish={chrome.canPublish} />
    </CmsEnvProvider>
  );
}
