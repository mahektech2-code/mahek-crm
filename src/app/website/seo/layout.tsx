import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website seo module: `website.seo`. */
export default async function WebsiteSeoLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("seo");
  return children;
}
