import { requireWebsiteReview } from "../require-module";

/** Route guard for the assign screen and the enforcement switch: `website.review`. */
export default async function WebsiteAssignmentsLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteReview();
  return children;
}
