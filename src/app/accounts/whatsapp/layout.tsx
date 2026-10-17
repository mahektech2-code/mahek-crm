import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for WhatsApp in Accounts — see the CRM's own for why a layout. */
export default async function AccountsWhatsappModuleLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  await requireModule(user.id, "accounts.whatsapp");
  return children;
}
