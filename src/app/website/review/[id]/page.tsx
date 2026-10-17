import { notFound } from "next/navigation";
import { readRequest } from "@/lib/website-cms/commands";
import { nowMs } from "@/lib/format";
import { websitePublicUrl } from "@/lib/website-cms/live-site";
import { requestHistory } from "@/lib/website-cms/review-queries";
import { CmsEnvProvider } from "../../cms-ui/cms-env";
import { RequestPage } from "../../cms-ui/request-page";

/** A request under review: the changes read field by field, and the two decisions. */
export default async function WebsiteReviewRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const read = await readRequest(id);
  if (!read.ok) notFound();
  const history = await requestHistory(id);
  return (
    <CmsEnvProvider media={[]} siteUrl={websitePublicUrl()} products={[]}>
      <RequestPage request={read.data} history={history} now={nowMs()} mode="review" />
    </CmsEnvProvider>
  );
}
