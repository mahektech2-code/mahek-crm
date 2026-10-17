import { notFound, redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { readRequest } from "@/lib/website-cms/commands";
import { nowMs } from "@/lib/format";
import { websitePublicUrl } from "@/lib/website-cms/live-site";
import { requestHistory } from "@/lib/website-cms/review-queries";
import { CmsEnvProvider } from "../../cms-ui/cms-env";
import { RequestPage } from "../../cms-ui/request-page";

/**
 * One of the signed-in person's own requests. `readRequest` is the rule — the
 * submitter or a reviewer, and nobody else — so a request that is not yours is
 * "not found", not "forbidden". A reviewer who lands here is sent to the page
 * with the decision on it.
 */
export default async function WebsiteMyRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser();
  const read = await readRequest(id);
  if (!read.ok) notFound();
  if (read.data.submitterId !== user.id) redirect(`/website/review/${id}`);
  const history = await requestHistory(id);
  return (
    <CmsEnvProvider media={[]} siteUrl={websitePublicUrl()} products={[]}>
      <RequestPage request={read.data} history={history} now={nowMs()} mode="mine" />
    </CmsEnvProvider>
  );
}
