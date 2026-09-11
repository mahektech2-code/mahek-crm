import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import {
  getEnquiry,
  assignableUsers,
  findPossibleDuplicateEnquiries,
  ordersForLinking,
  markEnquiryViewedIfFirst,
} from "@/lib/services/enquiry-service";
import { readSubmissionFields } from "@/lib/enquiry-submission";
import { EnquiryDetailScreen } from "@/components/enquiries/enquiry-detail-screen";

export const metadata = { title: "Enquiry — Website Enquiries" };

export default async function EnquiryDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await requireUser();

  const enquiry = await getEnquiry(id);
  if (!enquiry) notFound();

  // Best-effort, and never allowed to block the page rendering.
  try {
    await markEnquiryViewedIfFirst(id, user.id);
  } catch {
    /* the enquiry still opens even if the event could not be written */
  }

  const fields = readSubmissionFields(enquiry.rawSubmission);
  const phone = enquiry.customerPhone ?? fields.phone;

  const [team, duplicates, orderCandidates] = await Promise.all([
    assignableUsers(),
    findPossibleDuplicateEnquiries(id, phone),
    ordersForLinking(id),
  ]);

  return (
    <EnquiryDetailScreen
      enquiry={enquiry}
      submission={fields}
      team={team}
      duplicates={duplicates}
      orderCandidates={orderCandidates}
    />
  );
}
