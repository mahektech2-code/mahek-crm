import { requireWebsiteReview } from "../require-module";

/** Route guard for the review queue and a request under review: `website.review`. */
export default async function WebsiteReviewLayout({ children }: { children: React.ReactNode }) {
  await requireWebsiteReview();
  return children;
}
