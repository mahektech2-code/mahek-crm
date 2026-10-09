import { requireWebsiteModule } from "../require-module";

/** Route guard for the Website milestones module: `website.milestones`. */
export default async function WebsiteMilestonesLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteModule("milestones");
  return children;
}
