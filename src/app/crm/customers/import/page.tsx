import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { canFor } from "@/lib/access-control";
import { listTeam } from "@/lib/queries";
import { ImportScreen } from "./import-screen";

export const metadata = { title: "Import customers - MahekOne CRM" };

export default async function ImportPage() {
  const user = await requireUser();
  /* The same rule the two import actions enforce — `sheet.import`, not "a
     manager of something somewhere". The CRM grant is the layout's already. */
  if (!(await canFor(user, "sheet.import"))) redirect("/crm/customers");

  const team = await listTeam();
  return <ImportScreen team={team.map((t) => ({ id: t.id, name: t.name }))} />;
}
