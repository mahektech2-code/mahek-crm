import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website careers module: `website.careers`. */
export default async function WebsiteCareersLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("careers");
  return children;
}
