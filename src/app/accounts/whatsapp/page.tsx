import { WhatsappPage } from "@/app/crm/whatsapp/whatsapp-page";

export const metadata = { title: "WhatsApp - MahekOne Accounts" };

/*
 * The CRM's own screen, not a second one: two screens over one set of
 * conversations is how a reply sent from one goes missing from the other.
 * Read through the Accounts scope, which is every customer.
 */
export default function AccountsWhatsappPage({
  searchParams,
}: {
  searchParams: Promise<{ customer?: string; tab?: string; chat?: string }>;
}) {
  return <WhatsappPage app="accounts" searchParams={searchParams} />;
}
