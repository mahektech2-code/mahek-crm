import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/**
 * The route guard for WhatsApp on the Founder Dashboard. The layout above has
 * already checked the Founder grant; this checks the module, so a founder
 * grant narrowed to leave WhatsApp out cannot reach it by bookmark. The writes
 * behind the screen check again, in the service (`requireFounderDesk`).
 */
export default async function FounderWhatsappModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "founder.whatsapp");
  return children;
}
