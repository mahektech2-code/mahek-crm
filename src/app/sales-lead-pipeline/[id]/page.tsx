import { LeadRecordScreen } from "@/components/sales-lead-pipeline/lead-record-screen";

export const metadata = { title: "Lead record — Sales Manager — MahekOne" };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <LeadRecordScreen leadId={id} />;
}
