import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps, listUserModules } from "@/lib/access";
import { ToastProvider } from "@/components/ui/toast";

/**
 * The Founder Command Centre's gate.
 *
 * The access is the GRANT, not a role — an admin without the Founder app does
 * not get in. Each section and each desk checks its own module as well, on the
 * server, because a link that is not drawn is not a permission (PRD P11).
 */
export default async function FounderLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("founder")) redirect("/apps");
  const modules = await listUserModules(user.id, "founder");
  if (modules.length === 0) redirect("/apps");
  return <ToastProvider>{children}</ToastProvider>;
}
