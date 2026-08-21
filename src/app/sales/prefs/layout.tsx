import { requireUser } from "@/lib/auth";
import { requireModule } from "@/lib/access";

/** The route guard for Field settings. See the Approvals layout. */
export default async function SettingsModuleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await requireUser();
  await requireModule(user.id, "sales.prefs");
  return children;
}
