import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canOpenModule, requireModule } from "@/lib/access";
import { canFor } from "@/lib/access-control";
import { DESK_MODULE } from "@/lib/services/lead-desk-assignment-service";
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

  // The guard the worklist's folder layout used to give everything under it:
  // the detail page is the worklist's module, and a bookmarked enquiry must
  // not open for somebody who was never given it.
  await requireModule(user.id, "enquiries.list");

  const enquiry = await getEnquiry(id);
  if (!enquiry) notFound();

  // Best-effort, and never allowed to block the page rendering.
  try {
    await markEnquiryViewedIfFirst(id, user.id);
  } catch {
    /* the enquiry still opens even if the event could not be written */
  }

  /* As it now reads — a person's corrections over what was submitted. */
  const fields = readSubmissionFields(enquiry.submission);
  const phone = enquiry.customerPhone ?? fields.phone;

  const [team, duplicates, orderCandidates, deskAccess, canCloseReminders] = await Promise.all([
    assignableUsers(),
    findPossibleDuplicateEnquiries(id, phone),
    ordersForLinking(id),
    canOpenModule(user.id, DESK_MODULE),
    canFor(user, "reminder.close"),
  ]);

  return (
    <EnquiryDetailScreen
      enquiry={enquiry}
      submission={fields}
      team={team}
      duplicates={duplicates}
      orderCandidates={orderCandidates}
      deskAccess={deskAccess}
      viewerId={user.id}
      canCloseReminders={canCloseReminders}
    />
  );
}
