import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { listUserApps } from "@/lib/access";
import { APPS } from "@/lib/apps";
import { AdminConsole } from "./console";

export const metadata = { title: "Admin Console · MahekOne" };

/**
 * Access is checked here, not just hidden on the launcher — a bookmarked
 * /admin must not open for somebody who was never given the app.
 */
export default async function Page() {
  const user = await requireUser();
  const apps = await listUserApps(user.id);
  if (!apps.includes("admin")) redirect("/apps");

  return <AdminConsole apps={APPS.filter((a) => apps.includes(a.id))} />;
}
