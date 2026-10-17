import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website industries module: `website.industries`. */
export default async function WebsiteIndustriesLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("industries");
  return children;
}
