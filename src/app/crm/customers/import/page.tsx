import { redirect } from "next/navigation";
import { isManager, requireUser } from "@/lib/auth";
import { listTeam } from "@/lib/queries";
import { ImportScreen } from "./import-screen";

export const metadata = { title: "Import customers - MahekOne CRM" };

export default async function ImportPage() {
  const user = await requireUser();
  if (!isManager(user)) redirect("/crm/customers");

  const team = await listTeam();
  return <ImportScreen team={team.map((t) => ({ id: t.id, name: t.name }))} />;
}
