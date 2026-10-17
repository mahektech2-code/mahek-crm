import { isQueueTab, type QueueTab } from "@/lib/website-cms/review-status";
import { reviewQueue } from "@/lib/website-cms/review-queries";
import { ReviewQueue } from "../cms-ui/review-queue";

/** The reviewer's queue. The tab is `?tab=`; anything else is the first tab, never an error. */
export default async function WebsiteReviewPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams;
  const asked = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab: QueueTab = isQueueTab(asked) ? asked : "pending";
  return <ReviewQueue queue={await reviewQueue(tab)} />;
}
