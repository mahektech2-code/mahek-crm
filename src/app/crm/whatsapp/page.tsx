import { WhatsappPage } from "./whatsapp-page";

export const metadata = { title: "WhatsApp - MahekOne CRM" };

export default function CrmWhatsappPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; tab?: string; chat?: string }>;
}) {
  return <WhatsappPage app="crm" searchParams={searchParams} />;
}
