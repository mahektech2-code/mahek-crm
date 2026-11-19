import { redirect } from "next/navigation";

/**
 * The Sales Manager's Edit used to be this page. It is a modal on the record
 * now (`components/leads/record/lead-edit-dialog.tsx`), so an old link or a
 * bookmark lands on the record, where Edit opens it.
 */
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  redirect(`/crm/leads/sales-manager/${id}`);
}
