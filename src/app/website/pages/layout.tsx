import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website pages module: `website.pages`. */
export default async function WebsitePagesLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("pages");
  return children;
}
