import { CmsEnvProvider } from "../cms-ui/cms-env";
import { chromeFor } from "../cms-ui/chrome-cache";
import { MediaScreen } from "../cms-ui/media-screen";

export default async function WebsiteMediaPage() {
  const chrome = await chromeFor();
  return (
    <CmsEnvProvider media={chrome.media} siteUrl={chrome.siteUrl} products={chrome.products}>
      <MediaScreen canPublish={chrome.canPublish} />
    </CmsEnvProvider>
  );
}
