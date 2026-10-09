import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website navigation module: `website.navigation`. */
export default async function WebsiteNavigationLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("navigation");
  return children;
}
